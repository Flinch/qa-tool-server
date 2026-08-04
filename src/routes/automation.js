import { Router } from 'express'
import { query as controlQuery } from '../db/pool.js'
import { requireAuth, requireRole, verifyToken } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { subscribe, unsubscribe, broadcast } from '../lib/sse.js'
import { triggerSuiteRun, reconcileStaleRuns, triggerGenerationRun, reconcileStaleGenerationRuns, triggerTestCaseRerun, triggerHealRun, triggerAuthSetupRun } from '../lib/automationTrigger.js'
import { getPrStatus } from '../lib/githubPrStatus.js'
import { listSuiteFiles, matchTestCaseToFile } from '../lib/githubSuiteFiles.js'
import { isAuthSetupBlocking, getAuthSetupStatus } from '../lib/authSetupStatus.js'
import { generateFailureDiagnosis } from '../lib/diagnoseFailure.js'

const { GITHUB_OWNER, GITHUB_REPO } = process.env

const router = Router({ mergeParams: true })

const staffOnly = requireRole('qa_engineer', 'admin')
const anyProjectMember = [requireAuth, requireTenantAccess]
const staffOnlyChain = [requireAuth, requireTenantAccess, staffOnly]

// GET /suites — bucket cards with counts + latest run summary. Staff +
// read-only clients who are project members.
router.get('/suites', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.db, req.params.id)
    // test_case_count prefers the latest run's actual total over the
    // automated_test_cases roster — that roster is insert-only (webhooks.js
    // adds a title the first time it's seen but never removes one for a
    // renamed/deleted test), so it only ever grows and drifts from reality.
    // The last real run's count doesn't have that problem. Roster count is
    // still the fallback for a suite that's never actually run yet.
    //
    // "latest" is scoped to scope='suite' only — confirmed a real bug where
    // a diagnostic re-run of one or two specific failed tests (scope=
    // 'test_cases', its own separate row by design so it never touches the
    // run it diagnosed) was the most RECENT row for that suite_id, so it
    // silently hijacked the suite card's displayed count/pass/fail down to
    // whatever tiny subset was re-run. This card must only ever reflect a
    // real full-suite run.
    const { rows } = await req.db.query(`
      SELECT s.*,
        COALESCE(latest.total, COUNT(atc.id)::int) AS test_case_count,
        latest.status AS latest_status,
        latest.passed AS latest_passed,
        latest.failed AS latest_failed,
        latest.started_at AS latest_started_at,
        latest.completed_at AS latest_completed_at,
        latest.error_message AS latest_error_message
      FROM automation_suites s
      LEFT JOIN automated_test_cases atc ON atc.suite_id = s.id
      LEFT JOIN LATERAL (
        SELECT * FROM test_runs tr
        WHERE tr.suite_id = s.id AND tr.scope = 'suite'
        ORDER BY tr.started_at DESC
        LIMIT 1
      ) latest ON true
      WHERE s.project_id = $1
      GROUP BY s.id, latest.total, latest.status, latest.passed, latest.failed, latest.started_at, latest.completed_at, latest.error_message
      ORDER BY s.name
    `, [req.params.id])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /suites — create a new suite bucket (e.g. "Regression"). platform
// drives which CI workflow generation/runs route to (see
// triggerGenerationRun's platform === 'web' branch); engine is only
// meaningful for non-web suites (maestro vs. appium) — web suites always
// run Playwright, so engine stays null for them, same convention every
// existing web suite across real tenants already uses.
router.post('/suites', ...staffOnlyChain, async (req, res) => {
  const { name, slug, platform, engine } = req.body
  if (!name?.trim() || !slug?.trim()) return res.status(400).json({ error: 'Name and slug are required' })
  if (platform !== undefined && !['web', 'ios', 'android'].includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' })
  }
  if (engine !== undefined && engine !== null && !['playwright', 'maestro', 'appium', 'api'].includes(engine)) {
    return res.status(400).json({ error: 'Invalid engine' })
  }
  try {
    const { rows } = await req.db.query(
      `INSERT INTO automation_suites (project_id, name, slug, platform, engine) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name.trim(), slug.trim().toLowerCase(), platform || 'web', engine || null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A suite with that slug already exists for this project' })
    res.status(500).json({ error: e.message })
  }
})

// GET /runs — recent executions (optionally ?suite_id=). scope='test_cases'
// rows (diagnostic re-runs of specific previously-failed tests) are Malik's
// own troubleshooting, never a real suite result — excluded for clients
// server-side, not just hidden in the UI, same as any other access rule.
router.get('/runs', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.db, req.params.id)
    const { suite_id } = req.query
    const params = [req.params.id]
    // Always suite runs only — diagnostic re-runs/grouped runs (scope=
    // 'test_cases') now live exclusively on the Engineering page's Runs
    // panel (GET /run-groups below), not here, for every role.
    let filter = ` AND tr.scope = 'suite'`
    if (suite_id) {
      filter += ` AND tr.suite_id = $${params.length + 1}`
      params.push(suite_id)
    }
    const { rows } = await req.db.query(`
      SELECT tr.*, s.name AS suite_name, s.slug AS suite_slug
      FROM test_runs tr
      JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.project_id = $1 ${filter}
      ORDER BY tr.started_at DESC
      LIMIT 50
    `, params)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /runs/:runId — detailed drill-down for one run. Same client
// exclusion as the list above, applied here too so a direct/shared link to
// a scope='test_cases' run id can't bypass it — 404s rather than 403s, same
// "not found" shape as any other access-denied case in this app.
router.get('/runs/:runId', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.db, req.params.id)
    const { rows } = await req.db.query(`
      SELECT tr.*, s.name AS suite_name, s.slug AS suite_slug
      FROM test_runs tr
      JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id = $1 AND tr.project_id = $2
    `, [req.params.runId, req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    if (rows[0].scope === 'test_cases' && req.userRole === 'client') {
      return res.status(404).json({ error: 'Not found' })
    }

    const { rows: results } = await req.db.query(
      `SELECT * FROM test_run_results WHERE test_run_id=$1 ORDER BY id`,
      [req.params.runId]
    )
    res.json({ ...rows[0], results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /runs/:runId/rerun — diagnostic re-run of specific FAILED results
// from a prior run, not the whole suite. Resolves each failed result's
// title to its real committed file (same listSuiteFiles/matchTestCaseToFile
// helpers the "View test cases" pages already use) and dispatches only
// those files via triggerTestCaseRerun.
//
// Also creates its own size-1 run_groups row, same as /runs/group-rerun —
// GET /run-groups (the Engineering page's "Runs" table) only ever looks at
// test_runs rows with a run_group_id set, so without this the dispatch
// really happens but is invisible there. A group of 1 renders as a plain
// individual run on the frontend (see GET /run-groups' own comment).
router.post('/runs/:runId/rerun', ...staffOnlyChain, async (req, res) => {
  const { result_ids } = req.body
  if (!Array.isArray(result_ids) || result_ids.length === 0) {
    return res.status(400).json({ error: 'At least 1 result_id is required' })
  }

  try {
    const { rows: runRows } = await req.db.query(`
      SELECT tr.*, s.id AS suite_id, s.slug AS suite_slug, s.platform AS suite_platform
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id=$1 AND tr.project_id=$2
    `, [req.params.runId, req.params.id])
    if (!runRows[0]) return res.status(404).json({ error: 'Run not found' })
    const run = runRows[0]

    const { rows: results } = await req.db.query(
      `SELECT * FROM test_run_results WHERE id = ANY($1::int[]) AND test_run_id=$2`,
      [result_ids, req.params.runId]
    )
    if (results.length !== result_ids.length) {
      return res.status(400).json({ error: 'One or more results were not found on this run' })
    }
    const notFailed = results.filter(r => r.status !== 'failed')
    if (notFailed.length > 0) {
      return res.status(400).json({ error: `Only failed results can be re-run (${notFailed.map(r => r.test_title).join(', ')} did not fail)` })
    }

    const files = await listSuiteFiles({ id: run.suite_id, slug: run.suite_slug, platform: run.suite_platform })
    const filePaths = []
    const unresolved = []
    for (const r of results) {
      const url = matchTestCaseToFile(r.test_title, files)
      // matchTestCaseToFile resolves to a GitHub html_url — recover the
      // repo-relative path from the matching file entry instead of parsing
      // the URL, since listSuiteFiles already carries both.
      const file = url && files.find(f => f.url === url)
      if (!file) unresolved.push(r.test_title)
      else filePaths.push(file.path)
    }
    if (unresolved.length > 0) {
      return res.status(400).json({ error: `Could not find a matching file for: ${unresolved.join(', ')}` })
    }

    const groupLabel = `Re-run: ${results.slice(0, 2).map(r => r.test_title).join(', ')}${results.length > 2 ? ` +${results.length - 2} more` : ''}`
    const { rows: groupRows } = await req.db.query(
      `INSERT INTO run_groups (project_id, label, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, groupLabel, req.userId]
    )

    const newRun = await triggerTestCaseRerun({
      db: req.db,
      tenantId: req.tenantId,
      projectId: req.params.id,
      suiteId: run.suite_id,
      filePaths,
      targetTitles: results.map(r => r.test_title),
      userId: req.userId,
      runGroupId: groupRows[0].id,
    })
    res.status(202).json(newRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /runs/group-rerun — Engineering page's "Run selected" action: re-run
// a set of failing tests picked from across the whole project, which may
// span multiple suites. GitHub Actions only ever dispatches one workflow
// per suite, so one test_runs row (one dispatch) still goes out per suite —
// but every row created here shares one new run_groups id, so the
// Engineering page can show/manage them as a single bundled entity
// regardless of how many suites were actually involved.
router.post('/runs/group-rerun', ...staffOnlyChain, async (req, res) => {
  const { items, label } = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least 1 item ({run_id, result_id}) is required' })
  }

  try {
    // One query per (run_id, result_id) pair rather than a single ANY() IN —
    // unlike the single-run rerun above, items here can legitimately belong
    // to different runs of different suites, so each pair must be checked
    // and resolved to its OWN run/suite rather than one shared run.
    const results = []
    for (const item of items) {
      const { rows } = await req.db.query(`
        SELECT trr.*, tr.suite_id, s.slug AS suite_slug, s.platform AS suite_platform
        FROM test_run_results trr
        JOIN test_runs tr ON tr.id = trr.test_run_id
        JOIN automation_suites s ON s.id = tr.suite_id
        WHERE trr.id = $1 AND trr.test_run_id = $2 AND tr.project_id = $3
      `, [item.result_id, item.run_id, req.params.id])
      if (!rows[0]) return res.status(400).json({ error: `Result ${item.result_id} not found on run ${item.run_id}` })
      if (rows[0].status !== 'failed') return res.status(400).json({ error: `Only failed results can be re-run (${rows[0].test_title} did not fail)` })
      results.push(rows[0])
    }

    // Group by suite — each group becomes its own CI dispatch.
    const bySuite = new Map()
    for (const r of results) {
      if (!bySuite.has(r.suite_id)) bySuite.set(r.suite_id, [])
      bySuite.get(r.suite_id).push(r)
    }

    // Resolve files for every suite before creating anything, so one bad
    // title fails the whole request instead of leaving a half-dispatched
    // group behind.
    const bySuiteResolved = []
    for (const [suiteId, suiteResults] of bySuite) {
      const first = suiteResults[0]
      const files = await listSuiteFiles({ id: suiteId, slug: first.suite_slug, platform: first.suite_platform })
      const filePaths = []
      const unresolved = []
      for (const r of suiteResults) {
        const url = matchTestCaseToFile(r.test_title, files)
        const file = url && files.find(f => f.url === url)
        if (!file) unresolved.push(r.test_title)
        else filePaths.push(file.path)
      }
      if (unresolved.length > 0) {
        return res.status(400).json({ error: `Could not find a matching file for: ${unresolved.join(', ')}` })
      }
      bySuiteResolved.push({ suiteId, filePaths, targetTitles: suiteResults.map(r => r.test_title) })
    }

    const groupLabel = label?.trim()
      || `Re-run: ${results.slice(0, 2).map(r => r.test_title).join(', ')}${results.length > 2 ? ` +${results.length - 2} more` : ''}`
    const { rows: groupRows } = await req.db.query(
      `INSERT INTO run_groups (project_id, label, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, groupLabel, req.userId]
    )
    const group = groupRows[0]

    const runs = []
    for (const { suiteId, filePaths, targetTitles } of bySuiteResolved) {
      runs.push(await triggerTestCaseRerun({
        db: req.db,
        tenantId: req.tenantId,
        projectId: req.params.id,
        suiteId,
        filePaths,
        targetTitles,
        userId: req.userId,
        runGroupId: group.id,
      }))
    }

    res.status(202).json({ run_group: group, runs })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// GET /run-groups — Engineering page's "Runs" panel: every diagnostic/
// grouped re-run (scope='test_cases'), bundled by run_groups id. A group
// with exactly one child run is rendered as a plain individual run by the
// frontend; this just returns the raw group -> children shape.
router.get('/run-groups', ...staffOnlyChain, async (req, res) => {
  try {
    const { rows: groups } = await req.db.query(
      `SELECT * FROM run_groups WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    )
    if (groups.length === 0) return res.json([])

    const { rows: runs } = await req.db.query(`
      SELECT tr.*, s.name AS suite_name, s.slug AS suite_slug
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.run_group_id = ANY($1::int[])
      ORDER BY tr.started_at ASC
    `, [groups.map(g => g.id)])

    const runsByGroup = new Map()
    for (const r of runs) {
      if (!runsByGroup.has(r.run_group_id)) runsByGroup.set(r.run_group_id, [])
      runsByGroup.get(r.run_group_id).push(r)
    }

    res.json(groups.map(g => ({ ...g, runs: runsByGroup.get(g.id) || [] })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /runs/:runId/cancel — user-initiated stop from the frontend. App-side
// only for now: the underlying GH Actions workflow keeps running (cancelling
// it for real is a known later fix), which is exactly why the /test-runs
// results webhook refuses to overwrite a cancelled row — the workflow's
// eventual report must not resurrect a run the user already dismissed.
// Guarded to non-terminal statuses so cancelling a just-finished run can't
// clobber real results that landed between page render and click.
router.post('/runs/:runId/cancel', ...staffOnlyChain, async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `UPDATE test_runs
       SET status='cancelled', completed_at=NOW()
       WHERE id=$1 AND project_id=$2 AND status IN ('pending','running')
       RETURNING id`,
      [req.params.runId, req.params.id]
    )
    if (!rows[0]) return res.status(409).json({ error: 'Run not found or already finished' })

    // Same event a real completion emits — any open Automation page reloads
    // its run list and clears its running-suite spinner/polling off this.
    broadcast(req.tenantId, 'run_completed', { run_id: rows[0].id })
    res.json({ cancelled: true, run_id: rows[0].id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /runs/:runId/heal — "diagnose and heal" ONE specific failed result
// (the medic-cross button next to a single failing test, not a batch
// action). Resolves the file the same way /rerun does, best-effort resolves
// a real linked test_case_id from the roster for traceability, then
// dispatches the healer directly at that file via triggerHealRun.
router.post('/runs/:runId/heal', ...staffOnlyChain, async (req, res) => {
  const { result_id, context } = req.body
  if (!result_id) return res.status(400).json({ error: 'result_id is required' })

  try {
    const { rows: runRows } = await req.db.query(`
      SELECT tr.*, s.id AS suite_id, s.slug AS suite_slug, s.platform AS suite_platform
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id=$1 AND tr.project_id=$2
    `, [req.params.runId, req.params.id])
    if (!runRows[0]) return res.status(404).json({ error: 'Run not found' })
    const run = runRows[0]

    const { rows: resultRows } = await req.db.query(
      `SELECT * FROM test_run_results WHERE id=$1 AND test_run_id=$2`,
      [result_id, req.params.runId]
    )
    if (!resultRows[0]) return res.status(404).json({ error: 'Result not found on this run' })
    const result = resultRows[0]
    if (result.status !== 'failed') {
      return res.status(400).json({ error: 'Only a failed result can be healed' })
    }

    const files = await listSuiteFiles({ id: run.suite_id, slug: run.suite_slug, platform: run.suite_platform })
    const url = matchTestCaseToFile(result.test_title, files)
    const file = url && files.find(f => f.url === url)
    if (!file) return res.status(400).json({ error: `Could not find a matching file for: ${result.test_title}` })

    const { rows: rosterRows } = await req.db.query(
      `SELECT test_case_id FROM automated_test_cases WHERE suite_id=$1 AND title=$2 AND test_case_id IS NOT NULL`,
      [run.suite_id, result.test_title]
    )
    const testCaseIds = rosterRows[0] ? [rosterRows[0].test_case_id] : []

    const newRun = await triggerHealRun({
      db: req.db,
      tenantId: req.tenantId,
      projectId: req.params.id,
      suiteId: run.suite_id,
      testCaseIds,
      targetTitle: result.test_title,
      filePath: file.path,
      context: typeof context === 'string' ? context.slice(0, 2000) : undefined,
      userId: req.userId,
    })
    res.status(202).json(newRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /runs/:runId/diagnose — explains WHY one specific failed result
// failed, separately from healing it: environmental/flaky noise vs a real
// regression the test correctly caught. Read-only and synchronous (one
// Claude call, no CI dispatch, no PR) — this is the fast "what happened"
// step; /heal above is the slow, expensive "fix it" step. Deliberately its
// own endpoint rather than folded into /heal so a teammate can look before
// deciding whether a real (costed) heal dispatch is even warranted.
router.post('/runs/:runId/diagnose', ...staffOnlyChain, async (req, res) => {
  const { result_id } = req.body
  if (!result_id) return res.status(400).json({ error: 'result_id is required' })

  try {
    const { rows: runRows } = await req.db.query(`
      SELECT tr.*, s.id AS suite_id, s.name AS suite_name
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id=$1 AND tr.project_id=$2
    `, [req.params.runId, req.params.id])
    if (!runRows[0]) return res.status(404).json({ error: 'Run not found' })
    const run = runRows[0]

    const { rows: resultRows } = await req.db.query(
      `SELECT * FROM test_run_results WHERE id=$1 AND test_run_id=$2`,
      [result_id, req.params.runId]
    )
    if (!resultRows[0]) return res.status(404).json({ error: 'Result not found on this run' })
    const result = resultRows[0]
    if (result.status !== 'failed') {
      return res.status(400).json({ error: 'Only a failed result can be diagnosed' })
    }

    // Best-effort linked test case, for real steps/expected context — same
    // roster lookup /heal already does for traceability.
    const { rows: tcRows } = await req.db.query(`
      SELECT tc.steps, tc.expected FROM automated_test_cases atc
      JOIN test_cases tc ON tc.id = atc.test_case_id
      WHERE atc.suite_id=$1 AND atc.title=$2 AND atc.test_case_id IS NOT NULL
    `, [run.suite_id, result.test_title])
    const linked = tcRows[0] || null

    // Recent history of this exact test in this suite, real runs only (same
    // tr.scope='suite' convention used throughout automation.js) — a
    // diagnostic re-run's own result never counts toward "the" run history,
    // and the run currently being diagnosed is excluded so it isn't counted
    // against itself.
    const { rows: history } = await req.db.query(`
      SELECT trr.status, trr.error_message
      FROM test_run_results trr
      JOIN test_runs tr2 ON tr2.id = trr.test_run_id
      WHERE tr2.suite_id=$1 AND trr.test_title=$2 AND tr2.scope='suite' AND tr2.id != $3
      ORDER BY tr2.completed_at DESC NULLS LAST
      LIMIT 5
    `, [run.suite_id, result.test_title, run.id])

    const diagnosis = await generateFailureDiagnosis({
      testTitle: result.test_title,
      suiteName: run.suite_name,
      errorMessage: result.error_message || '(no error message recorded)',
      steps: linked?.steps ? (Array.isArray(linked.steps) ? linked.steps.join('\n') : linked.steps) : null,
      expected: linked?.expected || null,
      history,
    })

    res.json(diagnosis)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /suites/:suiteId/test-cases — the suite's automated test case roster,
// each row annotated with a GitHub link when a real generated file matches
// its tc-<id> title prefix. Staff + read-only clients who are project
// members (Malik confirmed clients should see the same view as staff here,
// unlike Generation History's PR/file links which stayed staff-only) — but
// `origin`/`review_status` are AI-generation/healing workflow state, so
// those two fields are stripped for the client role below; this stays a
// plain coverage list for them, not an AI-review view.
router.get('/suites/:suiteId/test-cases', ...anyProjectMember, async (req, res) => {
  try {
    const { rows: suiteRows } = await req.db.query(
      `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
      [req.params.suiteId, req.params.id]
    )
    const suite = suiteRows[0]
    if (!suite) return res.status(404).json({ error: 'Suite not found' })

    const { rows } = await req.db.query(`
      SELECT atc.id, atc.title, atc.origin, atc.review_status, atc.test_case_id,
        tc.title AS linked_test_case_title
      FROM automated_test_cases atc
      LEFT JOIN test_cases tc ON tc.id = atc.test_case_id
      WHERE atc.suite_id = $1
      ORDER BY atc.title
    `, [suite.id])

    const files = await listSuiteFiles(suite)
    let testCases = rows.map(r => ({ ...r, github_url: matchTestCaseToFile(r.title, files) }))
    if (req.userRole === 'client') {
      testCases = testCases.map(({ origin, review_status, ...rest }) => rest)
    }

    res.json({ suite, testCases })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generated-test-cases — every AI-generated automated test case across
// every suite in the project, for The Lab's cross-suite view. Directory
// listing fetched once per distinct suite, not per row. Staff-only: this is
// AI-generation/healing workflow state (review_status, last-run diagnostics),
// not a client-facing health metric — unlike the suite-scoped roster route
// below, which stays client-visible as a plain coverage list.
router.get('/generated-test-cases', ...staffOnlyChain, async (req, res) => {
  try {
    // last_* fields power The Lab's per-test status + re-run/heal actions.
    // Scoped to tr.scope='suite' only — same reasoning as the GET /suites
    // fix: a diagnostic re-run/heal dispatch is its own separate row by
    // design (never touches the run it diagnosed) and must never get picked
    // up as "the" last run here either, or a passing test would flash as
    // failed (or vice versa) based on someone's unrelated troubleshooting.
    const { rows } = await req.db.query(`
      SELECT atc.id, atc.title, atc.origin, atc.review_status, atc.test_case_id,
        tc.title AS linked_test_case_title, tc.type, tc.steps, tc.expected,
        s.id AS suite_id, s.name AS suite_name, s.slug AS suite_slug, s.platform AS suite_platform,
        latest.id AS last_result_id, latest.test_run_id AS last_run_id,
        latest.status AS last_status, latest.error_message AS last_error_message,
        latest.completed_at AS last_run_at
      FROM automated_test_cases atc
      JOIN automation_suites s ON s.id = atc.suite_id
      LEFT JOIN test_cases tc ON tc.id = atc.test_case_id
      LEFT JOIN LATERAL (
        SELECT trr.id, trr.test_run_id, trr.status, trr.error_message, tr.completed_at
        FROM test_run_results trr
        JOIN test_runs tr ON tr.id = trr.test_run_id
        WHERE trr.test_title = atc.title AND tr.suite_id = atc.suite_id AND tr.scope = 'suite'
        ORDER BY tr.started_at DESC
        LIMIT 1
      ) latest ON true
      WHERE s.project_id = $1 AND atc.origin = 'generated'
      ORDER BY s.name, atc.title
    `, [req.params.id])

    const suitesById = new Map()
    for (const r of rows) {
      if (!suitesById.has(r.suite_id)) {
        suitesById.set(r.suite_id, { id: r.suite_id, name: r.suite_name, slug: r.suite_slug, platform: r.suite_platform })
      }
    }
    const filesBySuite = new Map()
    for (const suite of suitesById.values()) {
      filesBySuite.set(suite.id, await listSuiteFiles(suite))
    }

    const testCases = rows.map(r => ({
      ...r,
      github_url: matchTestCaseToFile(r.title, filesBySuite.get(r.suite_id) || []),
    }))

    res.json({ testCases })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /runs/trigger — kick off a manual run via GitHub workflow_dispatch
router.post('/runs/trigger', ...staffOnlyChain, async (req, res) => {
  const { suite_id } = req.body
  if (!suite_id) return res.status(400).json({ error: 'suite_id is required' })

  try {
    if (await isAuthSetupBlocking(req.db, req.params.id)) {
      const authSetupStatus = await getAuthSetupStatus(req.db, req.params.id)
      return res.status(409).json({
        error: "This project's login flow needs to be generated and its PR merged before tests can be generated or run",
        authSetupStatus,
      })
    }
    const run = await triggerSuiteRun({ db: req.db, tenantId: req.tenantId, projectId: req.params.id, suiteId: suite_id, userId: req.userId })
    res.status(202).json(run)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /auth-setup/generate — kick off generation of this project's
// per-project login flow (target/credentials -> agent -> PR). See
// lib/authSetupStatus.js for how the resulting run gates /generate and
// /runs/trigger below until its PR is merged.
router.post('/auth-setup/generate', ...staffOnlyChain, async (req, res) => {
  try {
    const run = await triggerAuthSetupRun({
      db: req.db,
      tenantId: req.tenantId,
      projectId: req.params.id,
      userId: req.userId,
    })
    res.status(202).json(run)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /generate — kick off a test GENERATION run (manual TCs -> agents -> PR)
router.post('/generate', ...staffOnlyChain, async (req, res) => {
  const { suite_id, test_case_ids } = req.body
  if (!suite_id) return res.status(400).json({ error: 'suite_id is required' })

  try {
    if (await isAuthSetupBlocking(req.db, req.params.id)) {
      const authSetupStatus = await getAuthSetupStatus(req.db, req.params.id)
      return res.status(409).json({
        error: "This project's login flow needs to be generated and its PR merged before tests can be generated or run",
        authSetupStatus,
      })
    }
    const run = await triggerGenerationRun({
      db: req.db,
      tenantId: req.tenantId,
      projectId: req.params.id,
      suiteId: suite_id,
      testCaseIds: test_case_ids,
      userId: req.userId,
    })
    res.status(202).json(run)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// GET /generation-runs — recent generation runs, newest first. Staff-only:
// PR URLs, branch names, and generation phase are AI-pipeline internals, not
// a client-facing health metric.
router.get('/generation-runs', ...staffOnlyChain, async (req, res) => {
  try {
    await reconcileStaleGenerationRuns(req.db, req.params.id)
    const { rows } = await req.db.query(`
      SELECT gr.*, s.id AS suite_pk, s.name AS suite_name, s.slug AS suite_slug, s.platform AS suite_platform
      FROM generation_runs gr
      JOIN automation_suites s ON s.id = gr.suite_id
      WHERE gr.project_id = $1
      ORDER BY gr.started_at DESC
      LIMIT 20
    `, [req.params.id])

    // failed_test_case_ids: which of this run's requested TCs have no real
    // generated file in the suite's actual GitHub directory. No structured
    // per-TC success/failure is stored anywhere (the CI script only ever
    // writes one aggregate error_message string), and automated_test_cases
    // is NOT a reliable "did this succeed" signal — confirmed for real: it's
    // only populated once the suite is actually EXECUTED (via the test-run
    // webhook), so a TC generated and merged this session with the suite
    // never re-run since has no roster row yet despite succeeding. The real
    // GitHub file listing is the only source of truth for "did this exist."
    const filesBySuite = new Map()
    const withFailedIds = []
    for (const r of rows) {
      if (!['completed', 'failed'].includes(r.status)) {
        withFailedIds.push({ ...r, failed_test_case_ids: [] })
        continue
      }
      if (!filesBySuite.has(r.suite_pk)) {
        filesBySuite.set(r.suite_pk, await listSuiteFiles({ id: r.suite_pk, slug: r.suite_slug, platform: r.suite_platform }))
      }
      const files = filesBySuite.get(r.suite_pk)
      const failed = (r.test_case_ids || []).filter(tcId => !matchTestCaseToFile(`tc-${tcId}`, files))
      withFailedIds.push({ ...r, failed_test_case_ids: failed })
    }
    // Live GitHub check per PR — cheap enough for ~20 rows, and avoids
    // needing a pull_request webhook receiver (GitHub-side setup, not just
    // code) just to know whether a PR landed. Runs in parallel, fails open
    // per-row (see githubPrStatus.js) so one bad lookup can't 500 the panel.
    const withPrStatus = await Promise.all(withFailedIds.map(async r => {
      if (r.pr_url) {
        const prStatus = await getPrStatus(r.pr_url)
        return { ...r, pr_status: prStatus }
      }
      // A failed run (heal or generate) that still has a branch_name (no PR)
      // is a checkpoint — the agent got killed before finishing, but
      // whatever it had already changed on disk was committed and pushed
      // rather than discarded (see heal-test.js/generate-tests.js's
      // checkpointProgress). Surface it as a plain branch link since there's
      // no PR to check status on.
      if (r.branch_name && GITHUB_OWNER && GITHUB_REPO) {
        return { ...r, branch_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${r.branch_name}` }
      }
      return r
    }))
    res.json(withPrStatus)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generation-runs/:runId/log — persisted live-agent-log lines for one
// run (see webhooks.js's POST /generation-logs, which is what CI writes
// these from). Backs GenerationLogModal's initial load — works the same
// whether the run is still in progress or already finished, since these
// are stored, not just broadcast live.
router.get('/generation-runs/:runId/log', ...staffOnlyChain, async (req, res) => {
  try {
    const { rows: runRows } = await req.db.query(
      `SELECT id FROM generation_runs WHERE id=$1 AND project_id=$2`,
      [req.params.runId, req.params.id]
    )
    if (!runRows[0]) return res.status(404).json({ error: 'Not found' })

    const { rows } = await req.db.query(
      `SELECT line, created_at FROM generation_run_logs WHERE generation_run_id=$1 ORDER BY id`,
      [req.params.runId]
    )
    res.json({ lines: rows.map(r => r.line) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /runs/stream — SSE. Native EventSource can't send Authorization headers,
// so the token is passed as a query param here instead, and verified manually.
router.get('/runs/stream', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'No token provided' })

  let decoded
  try {
    decoded = verifyToken(token)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  if (!['qa_engineer', 'admin', 'client'].includes(decoded.role)) {
    return res.status(403).json({ error: "You don't have access to this resource" })
  }
  if (decoded.role === 'client') {
    const { rows } = await controlQuery(
      `SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`,
      [req.params.id, decoded.sub]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  subscribe(req.params.id, res)
  res.write(`event: connected\ndata: {}\n\n`)

  const keepAlive = setInterval(() => res.write(':\n\n'), 25000)

  req.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe(req.params.id, res)
  })
})

export default router