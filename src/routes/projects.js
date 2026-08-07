import { Router } from 'express'
import { query } from '../db/pool.js' // control-plane pool
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { listVisibleTenants } from '../db/tenantRegistry.js'
import { resolveTenantPool } from '../db/tenantPool.js'
import { getPrStatus } from '../lib/githubPrStatus.js'
import { getAuthSetupStatus } from '../lib/authSetupStatus.js'
import { computeFlakyTests } from '../lib/flakyTests.js'
import { generateAdvisorInsights } from '../lib/qualityAdvisor.js'
import { generateExecutiveSummary } from '../lib/executiveSummary.js'

const router = Router()
router.use(requireAuth)

// Same validation bugs.js uses for attachment/comment images — kept as its
// own copy rather than a shared import since these are two independently
// evolving upload surfaces that just happen to use the same base64
// data-URL-in-column pattern (no object storage configured for this app).
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,/

// GET /projects — staff see every active tenant, clients only the ones
// they're a tenant_members of. Each tenant's own data (test_case_count,
// open_bug_count) now lives in a separate database per tenant, so this can
// no longer be one SQL join — fan out to each tenant's pool in parallel and
// merge in Node. Promise.allSettled so one unreachable tenant DB degrades
// to "missing from the list" instead of 500ing the whole page for everyone.
router.get('/', async (req, res) => {
  try {
    const tenants = await listVisibleTenants(req.userId, req.userRole)
    const settled = await Promise.allSettled(tenants.map(async t => {
      const db = await resolveTenantPool(t.id)
      // WHERE p.id=$1 stays even though, once real per-tenant databases
      // exist (Part 5), a tenant's db only ever has one projects row anyway
      // — during the identity-resolver bridge (now), every tenant still
      // shares the ONE physical database, so without this filter each
      // iteration silently returns whichever project row Postgres happens
      // to return first, not this tenant's own row. Caught by testing this
      // exact bug live. Zero downside to keeping it permanently.
      const { rows } = await db.query(`
        SELECT p.*,
          COUNT(DISTINCT tc.id)::int AS test_case_count,
          COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id = p.id AND tc.archived_at IS NULL
        LEFT JOIN bugs b ON b.project_id = p.id
        WHERE p.id = $1
        GROUP BY p.id
      `, [t.id])
      return rows[0]
    }))
    const projects = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) projects.push(r.value)
      else console.error(`GET /projects: tenant ${tenants[i].id} (${tenants[i].slug}) unreachable:`, r.reason)
    })
    projects.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    res.json(projects)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST / — provisioning a new tenant (creating its own database, running
// schema migrations, seeding defaults) is deliberately NOT a live HTTP
// route. It's a CLI-only operation (scripts/provisionTenant.js) run by hand
// off the always-on server process, so the database-creation-capable
// credential it needs never has to live on that process. See "Phase A:
// DB-per-client multi-tenancy" for why.

// GET /projects/:id
router.get('/:id', requireTenantAccess, async (req, res) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM projects WHERE id=$1`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /projects/:id — inline-editable name/client_name/description from
// the project page. Staff only (matches every other project-mutation
// route). name can't be edited blank; client_name/description can (they're
// optional — an empty string clears them, same as null).
router.patch('/:id', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  const { name, client_name, description, links, logo } = req.body

  const fields = []
  const values = []
  let i = 1

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
    fields.push(`name=$${i++}`); values.push(name.trim())
  }
  if (client_name !== undefined) {
    fields.push(`client_name=$${i++}`); values.push(client_name?.trim() || null)
  }
  if (description !== undefined) {
    fields.push(`description=$${i++}`); values.push(description?.trim() || null)
  }
  if (links !== undefined) {
    if (!Array.isArray(links) || links.some(l => !l?.label?.trim() || !l?.url?.trim())) {
      return res.status(400).json({ error: 'links must be an array of {label, url}' })
    }
    const cleaned = links.map(l => ({ label: l.label.trim(), url: l.url.trim() }))
    fields.push(`links=$${i++}`); values.push(JSON.stringify(cleaned))
  }
  if (logo !== undefined) {
    if (logo !== null && !IMAGE_DATA_URL.test(logo)) return res.status(400).json({ error: 'Invalid image format' })
    fields.push(`logo=$${i++}`); values.push(logo)
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
    const { rows } = await req.db.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/test-config — the real target URL/credentials CI
// dispatches against for this project (see lib/testEnvironment.js, the
// consumer). Staff-only, full stop — never reachable by the client role,
// same posture as every other internal-tooling surface. Never returns the
// raw password: hasCredentials + the username only, so the edit form can
// show "a password is already saved" without the client-side JS ever
// holding the real secret.
router.get('/:id/test-config', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM project_test_config WHERE project_id=$1`, [req.params.id])
    const config = rows[0]
    const creds = config?.test_credentials
    res.json({
      target_url: config?.target_url || null,
      api_base_url: config?.api_base_url || null,
      mobile_app_id_ios: config?.mobile_app_id_ios || null,
      mobile_app_id_android: config?.mobile_app_id_android || null,
      hasCredentials: !!creds?.password,
      credentialUsername: creds?.username || null,
      authSetupStatus: await getAuthSetupStatus(req.db, req.params.id),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /projects/:id/test-config — upsert. test_credentials, when
// provided, fully replaces whatever's stored (username+password go
// together); when omitted from the request entirely, the existing stored
// credentials are left untouched — the "leave blank to keep the current
// secret" pattern, so re-saving the target URL alone never accidentally
// wipes a working password.
router.patch('/:id/test-config', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  const { target_url, api_base_url, mobile_app_id_ios, mobile_app_id_android, test_credentials } = req.body

  try {
    const { rows: existingRows } = await req.db.query(`SELECT * FROM project_test_config WHERE project_id=$1`, [req.params.id])
    const existing = existingRows[0]

    const next = {
      target_url: target_url !== undefined ? (target_url?.trim() || null) : (existing?.target_url ?? null),
      api_base_url: api_base_url !== undefined ? (api_base_url?.trim() || null) : (existing?.api_base_url ?? null),
      mobile_app_id_ios: mobile_app_id_ios !== undefined ? (mobile_app_id_ios?.trim() || null) : (existing?.mobile_app_id_ios ?? null),
      mobile_app_id_android: mobile_app_id_android !== undefined ? (mobile_app_id_android?.trim() || null) : (existing?.mobile_app_id_android ?? null),
      test_credentials: test_credentials !== undefined
        ? (test_credentials?.username && test_credentials?.password
          ? { username: test_credentials.username.trim(), password: test_credentials.password, displayName: test_credentials.displayName?.trim() || undefined }
          : null)
        : (existing?.test_credentials ?? null),
    }

    const { rows } = await req.db.query(
      `INSERT INTO project_test_config (project_id, target_url, api_base_url, mobile_app_id_ios, mobile_app_id_android, test_credentials, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (project_id) DO UPDATE SET
         target_url=$2, api_base_url=$3, mobile_app_id_ios=$4, mobile_app_id_android=$5, test_credentials=$6, updated_by=$7, updated_at=NOW()
       RETURNING *`,
      [req.params.id, next.target_url, next.api_base_url, next.mobile_app_id_ios, next.mobile_app_id_android, JSON.stringify(next.test_credentials), req.userId]
    )
    const saved = rows[0]
    const creds = saved.test_credentials
    res.json({
      target_url: saved.target_url,
      api_base_url: saved.api_base_url,
      mobile_app_id_ios: saved.mobile_app_id_ios,
      mobile_app_id_android: saved.mobile_app_id_android,
      hasCredentials: !!creds?.password,
      credentialUsername: creds?.username || null,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/stats
router.get('/:id/stats', requireTenantAccess, async (req, res) => {
  try {
    // Same fix as GET /:id/health — passed/failed/notRun sourced from real
    // execution history (execution_run_test_cases), not test_cases.status,
    // which execution runs never write to.
    const { rows } = await req.db.query(`
      WITH latest_execution AS (
        SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE er.project_id = $1 AND erc.status != 'not_run'
        ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
      )
      SELECT
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'pass')::int AS passed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'fail')::int AS failed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'blocked')::int AS blocked,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.test_case_id IS NULL)::int AS "notRun",
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id AND tc.archived_at IS NULL
      LEFT JOIN latest_execution le ON le.test_case_id = tc.id
      LEFT JOIN bugs b ON b.project_id = p.id
      WHERE p.id = $1
    `, [req.params.id])
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/health — quality-health dashboard data (see DECISIONS.md
// "Phase 4 — quality health dashboard" for the healthStatus thresholds and
// why the trend is sourced from execution_runs rather than test_cases.status).
router.get('/:id/health', requireTenantAccess, async (req, res) => {
  try {
    const projectId = req.params.id

    const [testCaseRows, bugRows, coverageRows, trendRows, weekRows, priorWeekRows, automatedCatchRows, requirementCoverageRows, uncoveredRequirementRows, bugHotspotRows] = await Promise.all([
      req.db.query(`
        WITH latest_execution AS (
          SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
          FROM execution_run_test_cases erc
          JOIN execution_runs er ON er.id = erc.execution_run_id
          WHERE er.project_id = $1 AND erc.status != 'not_run'
          ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
        )
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'pass')::int AS passed,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'fail')::int AS failed,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'blocked')::int AS blocked,
          COUNT(DISTINCT tc.id) FILTER (WHERE le.test_case_id IS NULL)::int AS "notRun"
        FROM test_cases tc
        LEFT JOIN latest_execution le ON le.test_case_id = tc.id
        WHERE tc.project_id = $1 AND tc.archived_at IS NULL
      `, [projectId]),
      req.db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM bugs
        WHERE project_id = $1 AND status = 'open'
        GROUP BY severity
      `, [projectId]),
      req.db.query(`
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
        FROM test_cases tc
        LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
        WHERE tc.project_id = $1 AND tc.archived_at IS NULL
      `, [projectId]),
      req.db.query(`
        SELECT er.id, er.completed_at,
          COUNT(erc.id) FILTER (WHERE erc.status = 'pass')::int AS passed,
          COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
        FROM execution_runs er
        JOIN execution_run_test_cases erc ON erc.execution_run_id = er.id
        WHERE er.project_id = $1 AND er.status = 'completed'
        GROUP BY er.id, er.completed_at, er.created_at
        ORDER BY er.created_at DESC
        LIMIT 8
      `, [projectId]),
      // Blended pass rate across everything actually executed in the last 7
      // days, regardless of which execution run it belongs to or whether
      // that run itself is marked completed yet — a brand-new project only
      // has a handful of runs, all from today, so the per-run trend line
      // above can't show real history for weeks; this gives a stable weekly
      // number immediately, and stays meaningful once per-run history grows.
      req.db.query(`
        SELECT
          COUNT(erc.id) FILTER (WHERE erc.status = 'pass')::int AS passed,
          COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE er.project_id = $1 AND erc.executed_at >= NOW() - INTERVAL '7 days'
      `, [projectId]),
      // Same shape, one week earlier — purely so the "Value delivered" panel
      // can show a week-over-week direction (improving/declining/flat)
      // instead of just a bare current number with nothing to compare it to.
      req.db.query(`
        SELECT
          COUNT(erc.id) FILTER (WHERE erc.status = 'pass')::int AS passed,
          COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE er.project_id = $1 AND erc.executed_at >= NOW() - INTERVAL '14 days' AND erc.executed_at < NOW() - INTERVAL '7 days'
      `, [projectId]),
      // Bugs the automation itself caught this month (origin='automated') —
      // the concrete "value" number: issues found by continuous testing
      // before a person had to stumble onto them manually.
      req.db.query(`
        SELECT COUNT(*)::int AS count FROM bugs
        WHERE project_id = $1 AND origin = 'automated' AND created_at >= NOW() - INTERVAL '30 days'
      `, [projectId]),
      // Same "has at least one link" definition of coverage already used on
      // the Requirements page itself (linked_test_case_count > 0) — kept
      // identical on purpose so this dashboard and that page never disagree
      // about what "covered" means.
      req.db.query(`
        SELECT
          COUNT(DISTINCT r.id)::int AS total,
          COUNT(DISTINCT r.id) FILTER (WHERE rtc.id IS NOT NULL)::int AS covered
        FROM requirements r
        LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
        WHERE r.project_id = $1 AND r.status = 'active'
      `, [projectId]),
      // The "story of the app" gap list — which active requirements have no
      // test coverage at all yet. Titles only, same non-AI health-metric
      // level of detail as the rest of this route.
      req.db.query(`
        SELECT r.id, r.title
        FROM requirements r
        LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
        WHERE r.project_id = $1 AND r.status = 'active' AND rtc.id IS NULL
        ORDER BY r.created_at
        LIMIT 10
      `, [projectId]),
      // Open bugs grouped by feature — same feature_id-based grouping
      // QualityHealth's pass-rate breakdown already uses, just for bug
      // counts instead. Starts FROM features (not bugs) and LEFT JOINs bugs
      // filtered inside the join condition, not WHERE — every feature shows
      // up even with zero open bugs, so the panel reads as a full feature
      // roster rather than only the ones currently in trouble. Bugs with no
      // feature assigned still can't be placed (bugs require a feature at
      // creation time, see bugs.js) but that's not this query's concern.
      // No LIMIT — "all the features" means all of them, not just the top 8.
      req.db.query(`
        SELECT f.id AS feature_id, f.name AS feature_name, COUNT(b.id)::int AS open_bug_count,
          COUNT(b.id) FILTER (WHERE b.severity = 'critical')::int AS critical_count,
          COUNT(b.id) FILTER (WHERE b.severity = 'high')::int AS high_count,
          COUNT(b.id) FILTER (WHERE b.severity = 'medium')::int AS medium_count,
          COUNT(b.id) FILTER (WHERE b.severity = 'low')::int AS low_count
        FROM features f
        LEFT JOIN bugs b ON b.feature_id = f.id AND b.status != 'resolved'
        WHERE f.project_id = $1
        GROUP BY f.id, f.name
        ORDER BY critical_count DESC, high_count DESC, open_bug_count DESC, f.name
      `, [projectId]),
    ])

    const tc = testCaseRows.rows[0]
    const passRate = tc.total > 0 ? Math.round((tc.passed / tc.total) * 100) : null

    const bugsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const row of bugRows.rows) bugsBySeverity[row.severity] = row.count

    const cov = coverageRows.rows[0]
    const automationCoverage = cov.total > 0 ? Math.round((cov.automated / cov.total) * 100) : null

    const reqCov = requirementCoverageRows.rows[0]
    const requirementCoverage = reqCov.total > 0 ? Math.round((reqCov.covered / reqCov.total) * 100) : null

    const passRateTrend = trendRows.rows
      .filter(r => r.total > 0)
      .map(r => ({ date: r.completed_at, passRate: Math.round((r.passed / r.total) * 100) }))
      .reverse()

    const week = weekRows.rows[0]
    const passRateThisWeek = week.total > 0 ? Math.round((week.passed / week.total) * 100) : null
    const priorWeek = priorWeekRows.rows[0]
    const passRatePriorWeek = priorWeek.total > 0 ? Math.round((priorWeek.passed / priorWeek.total) * 100) : null
    const bugsCaughtByAutomationThisMonth = automatedCatchRows.rows[0].count

    // Single blended health number — weighted average of pass rate and
    // requirement coverage (a project missing one shouldn't have that null
    // drag its score down), then a bug penalty on top since open critical/
    // high bugs are a real signal pass rate alone can miss (e.g. a critical
    // bug with no test case yet). null only when there's truly nothing to
    // measure yet, same condition as the old passRate-only
    // "insufficient_data" case.
    //
    // Deliberately NOT automation coverage: that's a testing-process metric
    // (how efficiently you verify things), not a product-health metric (is
    // the app actually working). Weighting it in implied "less automated =
    // less healthy," which isn't true — automation coverage still matters,
    // it's just shown as its own KPI, not folded into this score.
    //
    // Flaky tests are a real signal the client never sees directly (that's
    // automation-internals detail, staff-only on the Engineering Dashboard)
    // but they should still move the one number the client does see — only
    // the count is used here, the list itself is discarded.
    const flakyCount = (await computeFlakyTests(req.db, projectId, { limit: 50 })).length

    let qualityScore = null
    const weighted = [
      passRate !== null && { value: passRate, weight: 0.65 },
      requirementCoverage !== null && { value: requirementCoverage, weight: 0.35 },
    ].filter(Boolean)
    if (weighted.length > 0) {
      const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0)
      const base = weighted.reduce((sum, w) => sum + w.value * w.weight, 0) / totalWeight
      const bugPenalty = Math.min(40, bugsBySeverity.critical * 15) + Math.min(25, bugsBySeverity.high * 6)
      const flakePenalty = Math.min(15, flakyCount * 3)
      qualityScore = Math.max(0, Math.min(100, Math.round(base - bugPenalty - flakePenalty)))
    }

    let healthStatus
    if (qualityScore === null) {
      healthStatus = 'insufficient_data'
    } else if (bugsBySeverity.critical > 0 || qualityScore < 70) {
      healthStatus = 'needs_attention'
    } else if (bugsBySeverity.high > 0 || qualityScore < 90) {
      healthStatus = 'good'
    } else {
      healthStatus = 'excellent'
    }

    res.json({
      healthStatus,
      qualityScore,
      passRate,
      testCases: { total: tc.total, passed: tc.passed, failed: tc.failed, blocked: tc.blocked, notRun: tc.notRun },
      bugsBySeverity,
      automationCoverage,
      automatedTestCases: cov.automated,
      totalTestCases: cov.total,
      requirementCoverage,
      coveredRequirements: reqCov.covered,
      totalRequirements: reqCov.total,
      uncoveredRequirements: uncoveredRequirementRows.rows,
      bugHotspots: bugHotspotRows.rows.map(r => ({
        featureId: r.feature_id, featureName: r.feature_name, openBugCount: r.open_bug_count,
        criticalCount: r.critical_count, highCount: r.high_count, mediumCount: r.medium_count, lowCount: r.low_count,
      })),
      passRateTrend,
      passRateThisWeek,
      passRatePriorWeek,
      bugsCaughtByAutomationThisMonth,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/engineering-health — staff-only counterpart to
// GET /:id/health: engineering-facing signal (failing tests, broken
// environments, PR validation, automation review backlog) rather than the
// client-facing health story. Every field here is off-limits to clients
// under the AI-visibility rule (PR/review-status content), which is why
// this is its own staff-gated route rather than more fields bolted onto
// the client-facing one.
router.get('/:id/engineering-health', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  try {
    const projectId = req.params.id

    const [failingRows, environmentalRows, prRunRows, reviewStatusRows] = await Promise.all([
      // Tests that are CURRENTLY failing — i.e. whose most recent real suite
      // run result is a failure, not just whose most recent FAILURE happens
      // to be recent. The old version filtered to status='failed' before
      // picking "most recent," so a test that failed last week and has
      // since passed in every run since kept showing up here forever —
      // confirmed live, this is exactly what made the "Failing now" KPI
      // read wrong. Fixed by taking the true latest result per
      // (test_title, suite_id) regardless of status, THEN filtering to
      // failed — same tr.scope='suite' reasoning used throughout
      // automation.js so a one-off diagnostic re-run never masquerades as
      // "the" current failure state.
      req.db.query(`
        SELECT test_title, error_message, completed_at, suite_name, suite_id, result_id, run_id, test_case_id, tc_title, type, steps, expected
        FROM (
          SELECT DISTINCT ON (trr.test_title, tr.suite_id)
            trr.test_title, trr.error_message, trr.status, tr.completed_at, s.name AS suite_name, s.id AS suite_id,
            trr.id AS result_id, tr.id AS run_id,
            atc.test_case_id, tc.title AS tc_title, tc.type, tc.steps, tc.expected
          FROM test_run_results trr
          JOIN test_runs tr ON tr.id = trr.test_run_id
          JOIN automation_suites s ON s.id = tr.suite_id
          LEFT JOIN automated_test_cases atc ON atc.suite_id = s.id AND atc.title = trr.test_title
          LEFT JOIN test_cases tc ON tc.id = atc.test_case_id
          WHERE tr.project_id = $1 AND tr.scope = 'suite'
          ORDER BY trr.test_title, tr.suite_id, tr.completed_at DESC
        ) latest
        WHERE latest.status = 'failed'
        ORDER BY completed_at DESC
        LIMIT 15
      `, [projectId]),
      req.db.query(`
        SELECT id, title, severity, created_at
        FROM bugs
        WHERE project_id = $1 AND is_environmental = true AND status != 'resolved'
        ORDER BY created_at DESC
        LIMIT 10
      `, [projectId]),
      req.db.query(`
        SELECT gr.id, gr.pr_url, gr.branch_name, gr.status, gr.kind, gr.target_title, gr.completed_at,
          ts.name AS target_suite_name
        FROM generation_runs gr
        LEFT JOIN automation_suites ts ON ts.id = gr.target_suite_id
        WHERE gr.project_id = $1 AND gr.pr_url IS NOT NULL
        ORDER BY gr.started_at DESC
        LIMIT 10
      `, [projectId]),
      req.db.query(`
        SELECT review_status, COUNT(*)::int AS count
        FROM automated_test_cases atc
        JOIN automation_suites s ON s.id = atc.suite_id
        WHERE s.project_id = $1
        GROUP BY review_status
      `, [projectId]),
    ])

    // Live GitHub check per PR, same fail-open-per-row pattern as
    // GET /automation/generation-runs.
    const prValidation = await Promise.all(prRunRows.rows.map(async r => {
      const prStatus = await getPrStatus(r.pr_url).catch(() => null)
      return { ...r, pr_status: prStatus }
    }))

    const reviewStatusCounts = { active: 0, pending_review: 0, healed_pending_review: 0, flagged_regression: 0 }
    for (const row of reviewStatusRows.rows) reviewStatusCounts[row.review_status] = row.count

    const flakyTests = await computeFlakyTests(req.db, projectId)

    res.json({
      failingTests: failingRows.rows,
      brokenEnvironments: environmentalRows.rows,
      prValidation,
      reviewStatusCounts,
      flakyTests,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/advisor — AI Quality Advisor (Phase 2.3). Staff-only,
// read-only: reasons over the same non-AI signals already surfaced
// elsewhere (bug hotspots, flaky tests, coverage gaps) to produce a short
// prioritized recommendation list. POST rather than GET since it's a real
// AI call each time, same convention as POST /critical-flows/review.
router.post('/:id/advisor', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  try {
    const projectId = req.params.id

    const [projectRows, coverageRows, requirementCoverageRows, bugHotspotRows, uncoveredRequirementRows, flakyTests] = await Promise.all([
      req.db.query(`SELECT name, client_name, description FROM projects WHERE id=$1`, [projectId]),
      req.db.query(`
        SELECT COUNT(DISTINCT tc.id)::int AS total, COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
        FROM test_cases tc LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
        WHERE tc.project_id = $1 AND tc.archived_at IS NULL
      `, [projectId]),
      req.db.query(`
        SELECT COUNT(DISTINCT r.id)::int AS total, COUNT(DISTINCT r.id) FILTER (WHERE rtc.id IS NOT NULL)::int AS covered
        FROM requirements r LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
        WHERE r.project_id = $1 AND r.status = 'active'
      `, [projectId]),
      req.db.query(`
        SELECT f.id AS feature_id, f.name AS feature_name, COUNT(b.id)::int AS open_bug_count
        FROM bugs b JOIN features f ON f.id = b.feature_id
        WHERE b.project_id = $1 AND b.status != 'resolved'
        GROUP BY f.id, f.name ORDER BY open_bug_count DESC LIMIT 8
      `, [projectId]),
      req.db.query(`
        SELECT r.id, r.title FROM requirements r
        LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
        WHERE r.project_id = $1 AND r.status = 'active' AND rtc.id IS NULL
        ORDER BY r.created_at LIMIT 10
      `, [projectId]),
      computeFlakyTests(req.db, projectId),
    ])

    const cov = coverageRows.rows[0]
    const reqCov = requirementCoverageRows.rows[0]

    const recommendations = await generateAdvisorInsights({
      project: projectRows.rows[0] || {},
      automationCoverage: cov.total > 0 ? Math.round((cov.automated / cov.total) * 100) : null,
      requirementCoverage: reqCov.total > 0 ? Math.round((reqCov.covered / reqCov.total) * 100) : null,
      bugHotspots: bugHotspotRows.rows.map(r => ({ featureName: r.feature_name, openBugCount: r.open_bug_count })),
      flakyTests,
      uncoveredRequirements: uncoveredRequirementRows.rows,
    })

    res.json({ recommendations })
  } catch (e) {
    console.error('Advisor error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/weekly-summary-narrative — open to clients too (unlike
// /advisor above): feeds the client-facing weekly summary PDF, and only
// ever reasons over signals already shown to the client elsewhere on the
// Dashboard (confirmed 2026-08-06 this is fine under the governing
// AI-visibility rule, which is about engineering-process-internal signals
// like PR/review status staying staff-only, not a blanket ban on AI text
// reaching clients). No DB queries here at all — the caller already
// computed every one of these numbers for the PDF itself, so this is purely
// "turn structured signals into a paragraph," guaranteeing the narrative
// can never disagree with the PDF's own tables. Fail-open: a missing key or
// a flaky call returns narrative: null rather than blocking the export.
router.post('/:id/weekly-summary-narrative', requireTenantAccess, async (req, res) => {
  try {
    const narrative = await generateExecutiveSummary(req.body)
    res.json({ narrative })
  } catch (e) {
    console.error('Weekly summary narrative error (continuing without one):', e.message)
    res.json({ narrative: null })
  }
})

// POST /projects/:id/members — admin only, grants a client user access to a
// tenant. Membership is control-plane data (it's an access-control decision
// that has to be made BEFORE a tenant DB connection is even opened), so this
// queries tenant_members/users via the control-plane pool, not req.db —
// deliberately no requireTenantAccess here.
router.post('/:id/members', requireRole('admin'), async (req, res) => {
  const { email } = req.body
  if (!email?.trim()) return res.status(400).json({ error: 'Email is required' })

  try {
    const { rows: userRows } = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()])
    if (!userRows[0]) return res.status(404).json({ error: 'No user with that email has registered yet' })

    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'client')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [req.params.id, userRows[0].id]
    )
    res.status(201).json({ added: email })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/members — admin only, lists clients this tenant has been shared with
router.get('/:id/members', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name
       FROM tenant_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1 AND tm.role = 'client'
       ORDER BY u.email`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /projects/:id/members/:userId — admin only, revokes a client's access
router.delete('/:id/members/:userId', requireRole('admin'), async (req, res) => {
  try {
    await query(
      `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    )
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
