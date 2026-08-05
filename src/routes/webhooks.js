import { Router } from 'express'
import crypto from 'crypto'
import { query as controlQuery } from '../db/pool.js'
import { resolveTenantPool } from '../db/tenantPool.js'
import { broadcast } from '../lib/sse.js'
import { exportPlansForTestCases } from '../lib/planExport.js'
import { describeFailure } from '../lib/describeFailure.js'
import { classifyFailure } from '../lib/classifyFailure.js'
import { resolveTestEnvironment } from '../lib/testEnvironment.js'

const GENERATION_STATUSES = ['pending', 'exploring', 'generating', 'healing', 'opening_pr', 'completed', 'failed']

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
      // A user-cancelled run stays cancelled — the GH workflow keeps running
      // after an app-side cancel (stopping the actual workflow is a known
      // later fix), so its report arriving minutes later must not silently
      // resurrect the run. Checked BEFORE the update (not folded into its
      // WHERE) because a no-match there would fall through to the INSERT
      // fallback below and create a duplicate orphan row instead.
      const { rows: cancelledRows } = await db.query(
        `SELECT id FROM test_runs WHERE correlation_id=$1 AND status='cancelled'`,
        [correlation_id]
      )
      if (cancelledRows[0]) {
        return res.status(200).json({ received: true, ignored: 'run was cancelled by the user', run_id: cancelledRows[0].id })
      }

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
      // r.api_trace is already a JSON string (report-results.js reads it
      // straight off the attachment file, never parses it) — pass it
      // through as-is. JSON.stringify()-ing it again here would double-
      // encode it into a quoted string scalar inside the JSONB column
      // instead of the actual array.
      await db.query(
        `INSERT INTO test_run_results (test_run_id, test_title, status, duration_ms, error_message, api_trace)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [runId, r.test_title, r.status, r.duration_ms != null ? Math.round(r.duration_ms) : null, r.error_message || null, r.api_trace || null]
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
      // r.test_title already carries the "TC-<id>: ..." prefix for a web
      // Playwright title (see the roster-linking comment above), but
      // testCase.title from test_cases is the bare title with no prefix —
      // using it directly here silently dropped the TC number exactly when
      // a real linked test case was found. Rebuild it explicitly instead of
      // relying on whichever string happened to already have it.
      const bugTitle = `Automated failure: ${testCase ? `TC-${testCase.id}: ${testCase.title}` : r.test_title}`

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

    const env = await resolveTestEnvironment(db, run.project_id, run.suite_platform)

    // target_url (Playwright's baseURL) only makes sense for the web
    // pipeline. Mobile has no equivalent binary-management yet (a known,
    // flagged gap) — app_id resolves to this project's configured id, or
    // the env-var fallback if unset.
    if (run.suite_platform !== 'web' && !env.mobileAppId) {
      return res.status(500).json({ error: `No app id configured for "${run.suite_platform}" suites — set it on this project's Test Environment, or MOBILE_TARGET_APP_ID_${run.suite_platform.toUpperCase()}` })
    }
    const platformFields = run.suite_platform === 'web'
      ? { target_url: env.targetUrl, api_base_url: env.apiBaseUrl }
      : { app_id: env.mobileAppId }

    res.json({
      project_id: tenantId,
      suite_id: run.suite_id,
      suite_slug: run.suite_slug,
      platform: run.suite_platform,
      engine: run.suite_engine,
      ...platformFields,
      test_credentials: env.credentials,
      auth_setup_file: env.authSetupFile,
      helpers_dir: env.helpersDir,
      plans: await exportPlansForTestCases(db, run.project_id, run.test_case_ids, run.suite_platform, run.suite_engine),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /run-config/:correlationId — the lighter counterpart to
// GET /generation-payload above, for CI jobs that need the target
// environment but not test plans: plain suite runs (playwright.yml,
// maestro-run.yml) and heals (heal-test.yml, heal-mobile-test.yml). Suite
// runs live in test_runs, heals live in generation_runs (kind='heal') — same
// correlation_id -> dispatch_index resolution either way, just a different
// table to join platform from.
router.get('/run-config/:correlationId', verifySecret, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.params.correlationId, null)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown correlation id' })

    const { rows: runRows } = await db.query(
      `SELECT tr.project_id, s.platform AS suite_platform
       FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
       WHERE tr.correlation_id = $1
       UNION ALL
       SELECT gr.project_id, s.platform AS suite_platform
       FROM generation_runs gr JOIN automation_suites s ON s.id = gr.suite_id
       WHERE gr.correlation_id = $1 AND gr.kind = 'heal'
       UNION ALL
       -- auth_setup runs aren't suite-scoped (suite_id is NULL) — no join,
       -- and 'web' is hardcoded since login-flow generation is a
       -- Playwright-only concept today (no mobile equivalent).
       SELECT gr.project_id, 'web' AS suite_platform
       FROM generation_runs gr
       WHERE gr.correlation_id = $1 AND gr.kind = 'auth_setup'`,
      [req.params.correlationId]
    )
    const run = runRows[0]
    if (!run) return res.status(404).json({ error: 'Unknown correlation id' })

    const env = await resolveTestEnvironment(db, run.project_id, run.suite_platform)
    res.json({
      target_url: env.targetUrl,
      api_base_url: env.apiBaseUrl,
      app_id: env.mobileAppId,
      test_credentials: env.credentials,
      auth_setup_file: env.authSetupFile,
      helpers_dir: env.helpersDir,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /heal-history/:correlationId — every heal script calls this once at
// the start, before building its prompt. A stateless CI job otherwise has
// no memory that a previous attempt at the SAME failing test ever happened
// — confirmed live (2026-08-03): two independent heal attempts at TC-65,
// hours apart, independently rediscovered the exact same root cause from
// scratch, and neither one's diagnosis survived to help the other, because
// nothing carried it forward. This closes that gap: find prior kind='heal'
// runs against the same target_title (the current run's own row already
// carries it, so nothing extra needs to be passed in), and surface just the
// agent's own narration (💬 text / 🤔 thinking) from each — the same
// filter GenerationLogModal.jsx applies for a human reading the log — since
// that's normally where the actual root-cause diagnosis lives, not the raw
// tool-call/tool-result noise.
router.get('/heal-history/:correlationId', verifySecret, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.params.correlationId, null)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown correlation id' })

    const { rows: currentRows } = await db.query(
      `SELECT target_title FROM generation_runs WHERE correlation_id=$1`,
      [req.params.correlationId]
    )
    const targetTitle = currentRows[0]?.target_title
    if (!targetTitle) return res.json({ attempts: [] })

    const { rows: priorRuns } = await db.query(`
      SELECT id, status, error_message, started_at, pr_url, branch_name
      FROM generation_runs
      WHERE kind='heal' AND target_title=$1 AND correlation_id != $2
      ORDER BY started_at DESC
      LIMIT 3
    `, [targetTitle, req.params.correlationId])

    const attempts = []
    for (const run of priorRuns) {
      const { rows: logRows } = await db.query(
        `SELECT line FROM generation_run_logs WHERE generation_run_id=$1 ORDER BY id`,
        [run.id]
      )
      const narration = logRows.map(r => r.line).filter(l => l.startsWith('💬') || l.startsWith('🤔')).slice(-8)
      attempts.push({
        status: run.status,
        started_at: run.started_at,
        error_message: run.error_message,
        pr_url: run.pr_url,
        branch_name: run.branch_name,
        narration,
      })
    }

    res.json({ attempts })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generation-history/:correlationId — same idea as /heal-history above,
// for the GENERATE pipeline: a stateless CI job otherwise has no memory that
// a previous attempt at generating the SAME test case(s) ever happened.
// Confirmed live (2026-08-04): TC-64 burned ~$7 and 18 minutes stuck
// retrying a stale browser ref after a failed click, then died with nothing
// generated — a retry with zero awareness of that would be liable to hit
// the exact same wall. Matched by kind='generate' + suite_id + test_case_ids
// array overlap (`&&`) rather than target_title equality — a generate run
// has no single target_title (that field is heal/auth_setup-only), and a
// batch's exact TC set can shift run to run, so "shares at least one TC
// with this run" is the right definition of "an attempt at this work"
// rather than requiring an exact set match.
router.get('/generation-history/:correlationId', verifySecret, async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.params.correlationId, null)
    const db = tenantId ? await resolveTenantPool(tenantId) : null
    if (!db) return res.status(404).json({ error: 'Unknown correlation id' })

    const { rows: currentRows } = await db.query(
      `SELECT suite_id, test_case_ids FROM generation_runs WHERE correlation_id=$1`,
      [req.params.correlationId]
    )
    const current = currentRows[0]
    if (!current?.test_case_ids?.length) return res.json({ attempts: [] })

    const { rows: priorRuns } = await db.query(`
      SELECT id, status, error_message, started_at, pr_url, branch_name
      FROM generation_runs
      WHERE kind='generate' AND suite_id=$1 AND test_case_ids && $2::int[] AND correlation_id != $3
      ORDER BY started_at DESC
      LIMIT 3
    `, [current.suite_id, current.test_case_ids, req.params.correlationId])

    const attempts = []
    for (const run of priorRuns) {
      const { rows: logRows } = await db.query(
        `SELECT line FROM generation_run_logs WHERE generation_run_id=$1 ORDER BY id`,
        [run.id]
      )
      const narration = logRows.map(r => r.line).filter(l => l.startsWith('💬') || l.startsWith('🤔')).slice(-8)
      attempts.push({
        status: run.status,
        started_at: run.started_at,
        error_message: run.error_message,
        pr_url: run.pr_url,
        branch_name: run.branch_name,
        narration,
      })
    }

    res.json({ attempts })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /generation-events — CI reports phase progress + completion here as
// the agent workflow moves through its phases. Same no-fallback shape as
// GET /generation-payload above — correlation_id is the only identifier in
// this payload at all.
router.post('/generation-events', verifySecret, async (req, res) => {
  const { correlation_id, status, pr_url, branch_name, error_message, github_run_url } = req.body

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
           github_run_url=COALESCE($5, github_run_url),
           completed_at = CASE WHEN $6 THEN NOW() ELSE completed_at END
       WHERE correlation_id=$7
       RETURNING id, pr_url`,
      [status, pr_url || null, branch_name || null, error_message || null, github_run_url || null, isTerminal, correlation_id]
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

// POST /generation-logs — CI flushes buffered, formatted agent-step lines
// here every ~2s as a run progresses (see each generation/heal script's
// printStreamEvent + flushLogs). Persisted (not just broadcast) so the
// frontend log viewer can show the full transcript for a run that already
// finished, not just whatever arrived while someone had it open live.
router.post('/generation-logs', verifySecret, async (req, res) => {
  const { correlation_id, lines } = req.body
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines must be a non-empty array' })
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
    const generationRunId = existing[0].id

    const values = []
    const placeholders = lines.map((line, i) => {
      values.push(generationRunId, line)
      return `($${i * 2 + 1}, $${i * 2 + 2})`
    }).join(',')
    await db.query(
      `INSERT INTO generation_run_logs (generation_run_id, line) VALUES ${placeholders}`,
      values
    )

    broadcast(tenantId, 'generation_log', { generation_run_id: generationRunId, lines })
    res.status(200).json({ received: true, count: lines.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
