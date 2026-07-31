import { Router } from 'express'
import crypto from 'crypto'
import { query as controlQuery } from '../db/pool.js'
import { resolveTenantPool } from '../db/tenantPool.js'
import { broadcast } from '../lib/sse.js'
import { exportPlansForTestCases } from '../lib/planExport.js'
import { describeFailure } from '../lib/describeFailure.js'
import { classifyFailure } from '../lib/classifyFailure.js'

const GENERATION_STATUSES = ['pending', 'exploring', 'generating', 'healing', 'opening_pr', 'completed', 'failed']

// One app id per mobile platform, not a single shared var — a single
// MOBILE_TARGET_APP_ID silently misdirected generation at whichever platform's
// bundle id happened to be set last (real wasted CI runs from this). Mirrors
// GITHUB_GENERATION_WORKFLOW_ID vs GITHUB_MOBILE_GENERATION_WORKFLOW_ID's
// existing per-platform-var pattern.
const MOBILE_APP_ID_BY_PLATFORM = {
  android: process.env.MOBILE_TARGET_APP_ID_ANDROID || 'com.sec.android.app.popupcalculator',
  ios: process.env.MOBILE_TARGET_APP_ID_IOS,
}

const router = Router()
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

function verifySecret(req, res, next) {
  const provided = String(req.headers['x-webhook-secret'] || '')
  const a = Buffer.from(provided)
  const b = Buffer.from(WEBHOOK_SECRET)
  if (a.length !== b.length || !WEBHOOK_SECRET || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid webhook secret' })
  }
  next()
}

// Resolves which tenant a webhook call belongs to. correlation_id is the
// authoritative signal — it's generated server-side at dispatch time and
// recorded in the control-plane dispatch_index (see automationTrigger.js's
// recordDispatch), so it can't be spoofed by anything CI reports back. When
// a correlation_id is present, the caller-supplied fallbackProjectId is
// NEVER trusted — that's what structurally fixes the original bug this
// whole rework exists for (a single hardcoded GitHub Actions repo variable
// meant every web result silently reported under the wrong project for any
// suite other than the one it happened to match).
//
// Falls back to trusting fallbackProjectId only when there's no
// correlation_id to look up at all — today that's exactly the nightly
// GitHub Actions cron trigger, which doesn't carry one yet. Provably safe
// during Phase A's identity-resolver stage (every tenant id still routes to
// the one shared physical database regardless), and gets closed for real in
// Part 6 once nightly runs are server-dispatched with real correlation_ids
// like every other run already is.
async function resolveTenantId(correlationId, fallbackProjectId) {
  if (correlationId) {
    const { rows } = await controlQuery(`SELECT tenant_id FROM dispatch_index WHERE correlation_id=$1`, [correlationId])
    if (rows[0]) return rows[0].tenant_id
  }
  return fallbackProjectId ? Number(fallbackProjectId) : null
}

router.post('/test-runs', verifySecret, async (req, res) => {
  const {
    correlation_id, project_id, suite_slug, trigger_type,
    status, total, passed, failed, skipped, duration_ms,
    report_url, github_run_url, error_message, results = [],
  } = req.body

  if (!project_id || !suite_slug || !status) {
    return res.status(400).json({ error: 'project_id, suite_slug, and status are required' })
  }

  try {
    const tenantId = await resolveTenantId(correlation_id, project_id)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown tenant' })

    const { rows: suiteRows } = await db.query(
      `SELECT id FROM automation_suites WHERE project_id=$1 AND slug=$2`,
      [tenantId, suite_slug]
    )
    if (!suiteRows[0]) return res.status(404).json({ error: 'Unknown suite for this project' })
    const suiteId = suiteRows[0].id

    let runId

    if (correlation_id) {
      const { rows } = await db.query(
        `UPDATE test_runs
         SET status=$1, total=$2, passed=$3, failed=$4, skipped=$5,
             duration_ms=$6, report_url=$7, github_run_url=$8, error_message=$9, completed_at=NOW()
         WHERE correlation_id=$10
         RETURNING id`,
        [status, total, passed, failed, skipped, duration_ms, report_url, github_run_url, error_message || null, correlation_id]
      )
      runId = rows[0]?.id
    }

    if (!runId) {
      const { rows } = await db.query(
        `INSERT INTO test_runs
           (project_id, suite_id, trigger_type, status, total, passed, failed, skipped,
            duration_ms, report_url, github_run_url, error_message, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         RETURNING id`,
        [tenantId, suiteId, trigger_type || 'nightly', status, total, passed, failed, skipped,
         duration_ms, report_url, github_run_url, error_message || null]
      )
      runId = rows[0].id
    }

    for (const r of results) {
      await db.query(
        `INSERT INTO test_run_results (test_run_id, test_title, status, duration_ms, error_message)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, r.test_title, r.status, r.duration_ms != null ? Math.round(r.duration_ms) : null, r.error_message || null]
      )
    }

    // Keep the suite's known test roster in sync with what actually ran, and
    // link each roster row back to the manual test case it automates.
    // Mobile Maestro's JUnit test name is the flow filename (e.g.
    // "tc-75-browse-catalog-and-add-product-to-cart"); web Playwright titles
    // follow the "TC-<id>: ..." convention from planExport.js. Both start
    // with tc-<digits>, so one case-insensitive prefix match resolves either
    // back to a real test case — falls back to null if there's no match or
    // it's not a real TC in this project. New test titles get added
    // automatically; renamed/removed ones just stop showing up in future
    // runs rather than being deleted here. DO UPDATE (not DO NOTHING) so a
    // roster row inserted before this linking existed self-heals on its next
    // real run instead of staying orphaned forever.
    const testCasesByResult = new Map()
    for (const r of results) {
      const tcMatch = /^tc-(\d+)/i.exec(r.test_title)
      let testCase = null
      if (tcMatch) {
        const { rows: tcRows } = await db.query(
          `SELECT id, title, expected, steps, feature_id FROM test_cases WHERE id=$1 AND project_id=$2`,
          [Number(tcMatch[1]), tenantId]
        )
        testCase = tcRows[0] || null
      }
      testCasesByResult.set(r, testCase)

      // origin mirrors test_case_id's own resolution exactly (same
      // tc-<id> match) — a roster row only counts as "generated" once
      // it's actually traceable back to a real manual test case, same bar
      // as test_case_id. Only ever upgrades manual -> generated on
      // conflict, never the reverse.
      await db.query(
        `INSERT INTO automated_test_cases (suite_id, title, test_case_id, origin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (suite_id, title) DO UPDATE SET
           test_case_id = COALESCE(automated_test_cases.test_case_id, EXCLUDED.test_case_id),
           origin = CASE WHEN EXCLUDED.origin = 'generated' THEN 'generated' ELSE automated_test_cases.origin END`,
        [suiteId, r.test_title, testCase?.id || null, testCase ? 'generated' : 'manual']
      )
    }

    // Auto-file a bug for any failed result — same contract for web and
    // mobile, so this covers both. Deliberately separate from the healer's
    // regression-flag path (see DECISIONS.md): this fires on any failure in
    // a normal run, not specifically a flagged regression.
    for (const r of results) {
      if (r.status !== 'failed') continue

      const testCase = testCasesByResult.get(r)
      const bugTitle = `Automated failure: ${testCase ? testCase.title : r.test_title}`

      // Dedup against repeat failures of the same test in the same suite —
      // a nightly cron failing every night shouldn't file a fresh bug each
      // time it hits the exact same problem. Only matches while an existing
      // one is still open/in_progress; once resolved, a new failure files a
      // new bug. A match gets refreshed (latest screenshot/description/run),
      // not silently ignored — otherwise the evidence on an old open bug
      // goes stale forever while the same failure keeps recurring.
      const { rows: existing } = await db.query(
        `SELECT id FROM bugs WHERE suite_id=$1 AND title=$2 AND origin='automated' AND status != 'resolved'`,
        [suiteId, bugTitle]
      )

      const stepsText = testCase
        ? (Array.isArray(testCase.steps) ? testCase.steps.join('\n') : testCase.steps)
        : `Run automation suite "${suite_slug}"`

      // Rewrite the raw assertion failure into a plain-language description a
      // QA analyst would write for a developer — falls back to the raw
      // message if no API key is configured or the call fails (fail-open,
      // same idiom as jiraClient.js).
      const description = await describeFailure({
        scenarioTitle: bugTitle.replace(/^Automated failure: /, ''),
        steps: stepsText,
        expected: testCase?.expected || null,
        errorMessage: r.error_message,
        screenshotBase64: r.screenshot_base64 || null,
      })

      const actual = description || r.error_message || null
      const notes = `Auto-filed from test run #${runId} (${trigger_type || 'manual'})${github_run_url ? ` — CI: ${github_run_url}` : ''}` +
        (description && r.error_message ? `\n\nRaw failure detail: ${r.error_message}` : '')
      const screenshotData = r.screenshot_base64 ? `data:image/png;base64,${r.screenshot_base64}` : null
      const isEnvironmental = classifyFailure(r.error_message)

      // Best-effort only — inherited from the linked test case when it has
      // one, never blocks bug-filing when it doesn't (unlike manual bug
      // creation, where a feature is required).
      const featureId = testCase?.feature_id || null

      if (existing[0]) {
        await db.query(
          `UPDATE bugs SET test_run_id=$1, actual=$2, notes=$3, screenshot_data=$4, is_environmental=$5, feature_id=COALESCE(feature_id, $6), updated_at=NOW() WHERE id=$7`,
          [runId, actual, notes, screenshotData, isEnvironmental, featureId, existing[0].id]
        )
        continue
      }

      await db.query(
        `INSERT INTO bugs
           (project_id, test_case_id, suite_id, test_run_id, title, severity,
            steps_to_reproduce, expected, actual, notes, origin, created_by, screenshot_data, is_environmental, feature_id)
         VALUES ($1,$2,$3,$4,$5,'medium',$6,$7,$8,$9,'automated',NULL,$10,$11,$12)`,
        [
          tenantId,
          testCase?.id || null,
          suiteId,
          runId,
          bugTitle,
          stepsText,
          testCase?.expected || null,
          actual,
          notes,
          screenshotData,
          isEnvironmental,
          featureId,
        ]
      )
    }

    broadcast(tenantId, 'run_completed', { run_id: runId })

    res.status(200).json({ received: true, run_id: runId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generation-payload/:correlationId — CI calls this back after
// workflow_dispatch to fetch the plans it needs (see automationTrigger.js
// for why only a correlation id crosses the dispatch boundary). Unlike
// /test-runs, there's no caller-supplied project_id to fall back to here at
// all — the correlation_id alone resolves the tenant via dispatch_index, so
// this endpoint has no legacy-compatibility path to carry forward.
router.get('/generation-payload/:correlationId', verifySecret, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.params.correlationId, null)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown correlation id' })

    const { rows } = await db.query(
      `SELECT gr.*, s.slug AS suite_slug, s.platform AS suite_platform, s.engine AS suite_engine
       FROM generation_runs gr
       JOIN automation_suites s ON s.id = gr.suite_id
       WHERE gr.correlation_id = $1`,
      [req.params.correlationId]
    )
    const run = rows[0]
    if (!run) return res.status(404).json({ error: 'Unknown correlation id' })

    // CI fetching the payload is the moment work actually begins.
    if (run.status === 'pending') {
      await db.query(`UPDATE generation_runs SET status='exploring' WHERE id=$1`, [run.id])
      broadcast(tenantId, 'generation_progress', { generation_run_id: run.id, status: 'exploring' })
    }

    // target_url (Playwright's baseURL) only makes sense for the web
    // pipeline. Mobile has no equivalent binary-management yet (a known,
    // flagged gap) — app_id is a stand-in env var default for now, same
    // category as target_url's own hardcoded fallback.
    if (run.suite_platform !== 'web' && !MOBILE_APP_ID_BY_PLATFORM[run.suite_platform]) {
      return res.status(500).json({ error: `No app id configured for "${run.suite_platform}" suites — set MOBILE_TARGET_APP_ID_${run.suite_platform.toUpperCase()}` })
    }
    const platformFields = run.suite_platform === 'web'
      ? { target_url: process.env.TARGET_URL || 'https://service-desk-roan.vercel.app' }
      : { app_id: MOBILE_APP_ID_BY_PLATFORM[run.suite_platform] }

    res.json({
      project_id: tenantId,
      suite_id: run.suite_id,
      suite_slug: run.suite_slug,
      platform: run.suite_platform,
      engine: run.suite_engine,
      ...platformFields,
      plans: await exportPlansForTestCases(db, run.project_id, run.test_case_ids, run.suite_platform, run.suite_engine),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /generation-events — CI reports phase progress + completion here as
// the agent workflow moves through its phases. Same no-fallback shape as
// GET /generation-payload above — correlation_id is the only identifier in
// this payload at all.
router.post('/generation-events', verifySecret, async (req, res) => {
  const { correlation_id, status, pr_url, branch_name, error_message } = req.body

  if (!GENERATION_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${GENERATION_STATUSES.join(', ')}` })
  }

  try {
    const tenantId = await resolveTenantId(correlation_id, null)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown correlation id' })

    const { rows: existing } = await db.query(
      `SELECT id FROM generation_runs WHERE correlation_id=$1`,
      [correlation_id]
    )
    if (!existing[0]) return res.status(404).json({ error: 'Unknown correlation id' })

    const isTerminal = status === 'completed' || status === 'failed'

    // No WHERE status guard: a completion webhook must be able to overwrite
    // a row the stale-run sweep already marked 'failed' — real results beat
    // a timeout guess (see reconcileStaleGenerationRuns for the full race).
    const { rows } = await db.query(
      `UPDATE generation_runs
       SET status=$1,
           pr_url=COALESCE($2, pr_url),
           branch_name=COALESCE($3, branch_name),
           error_message=$4,
           completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END
       WHERE correlation_id=$6
       RETURNING id, pr_url`,
      [status, pr_url || null, branch_name || null, error_message || null, isTerminal, correlation_id]
    )
    const run = rows[0]

    broadcast(tenantId, 'generation_progress', { generation_run_id: run.id, status, pr_url: run.pr_url })
    if (isTerminal) {
      broadcast(tenantId, 'generation_completed', { generation_run_id: run.id })
    }

    res.status(200).json({ received: true, generation_run_id: run.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
