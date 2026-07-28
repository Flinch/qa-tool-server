import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole, verifyToken } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'
import { subscribe, unsubscribe } from '../lib/sse.js'
import { triggerSuiteRun, reconcileStaleRuns, triggerGenerationRun, reconcileStaleGenerationRuns, triggerTestCaseRerun, triggerHealRun } from '../lib/automationTrigger.js'
import { getPrStatus } from '../lib/githubPrStatus.js'
import { listSuiteFiles, matchTestCaseToFile } from '../lib/githubSuiteFiles.js'

const router = Router({ mergeParams: true })

const staffOnly = requireRole('qa_engineer', 'admin')
const anyProjectMember = [requireAuth, requireProjectAccess]

// GET /suites — bucket cards with counts + latest run summary. Staff +
// read-only clients who are project members.
router.get('/suites', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.params.id)
    // test_case_count prefers the latest run's actual total over the
    // automated_test_cases roster — that roster is insert-only (webhooks.js
    // adds a title the first time it's seen but never removes one for a
    // renamed/deleted test), so it only ever grows and drifts from reality.
    // The last real run's count doesn't have that problem. Roster count is
    // still the fallback for a suite that's never actually run yet.
    const { rows } = await query(`
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
        WHERE tr.suite_id = s.id
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

// POST /suites — create a new suite bucket (e.g. "Regression")
router.post('/suites', requireAuth, staffOnly, async (req, res) => {
  const { name, slug } = req.body
  if (!name?.trim() || !slug?.trim()) return res.status(400).json({ error: 'Name and slug are required' })
  try {
    const { rows } = await query(
      `INSERT INTO automation_suites (project_id, name, slug) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, name.trim(), slug.trim().toLowerCase()]
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
    await reconcileStaleRuns(req.params.id)
    const { suite_id } = req.query
    const params = [req.params.id]
    let filter = ''
    if (suite_id) {
      filter += ` AND tr.suite_id = $${params.length + 1}`
      params.push(suite_id)
    }
    if (req.userRole === 'client') {
      filter += ` AND tr.scope = 'suite'`
    }
    const { rows } = await query(`
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
    await reconcileStaleRuns(req.params.id)
    const { rows } = await query(`
      SELECT tr.*, s.name AS suite_name, s.slug AS suite_slug
      FROM test_runs tr
      JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id = $1 AND tr.project_id = $2
    `, [req.params.runId, req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    if (rows[0].scope === 'test_cases' && req.userRole === 'client') {
      return res.status(404).json({ error: 'Not found' })
    }

    const { rows: results } = await query(
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
router.post('/runs/:runId/rerun', requireAuth, staffOnly, async (req, res) => {
  const { result_ids } = req.body
  if (!Array.isArray(result_ids) || result_ids.length === 0) {
    return res.status(400).json({ error: 'At least 1 result_id is required' })
  }

  try {
    const { rows: runRows } = await query(`
      SELECT tr.*, s.id AS suite_id, s.slug AS suite_slug, s.platform AS suite_platform
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id=$1 AND tr.project_id=$2
    `, [req.params.runId, req.params.id])
    if (!runRows[0]) return res.status(404).json({ error: 'Run not found' })
    const run = runRows[0]

    const { rows: results } = await query(
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

    const newRun = await triggerTestCaseRerun({
      projectId: req.params.id,
      suiteId: run.suite_id,
      filePaths,
      userId: req.userId,
    })
    res.status(202).json(newRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /runs/:runId/heal — "diagnose and heal" ONE specific failed result
// (the medic-cross button next to a single failing test, not a batch
// action). Resolves the file the same way /rerun does, best-effort resolves
// a real linked test_case_id from the roster for traceability, then
// dispatches the healer directly at that file via triggerHealRun.
router.post('/runs/:runId/heal', requireAuth, staffOnly, async (req, res) => {
  const { result_id } = req.body
  if (!result_id) return res.status(400).json({ error: 'result_id is required' })

  try {
    const { rows: runRows } = await query(`
      SELECT tr.*, s.id AS suite_id, s.slug AS suite_slug, s.platform AS suite_platform
      FROM test_runs tr JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.id=$1 AND tr.project_id=$2
    `, [req.params.runId, req.params.id])
    if (!runRows[0]) return res.status(404).json({ error: 'Run not found' })
    const run = runRows[0]

    const { rows: resultRows } = await query(
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

    const { rows: rosterRows } = await query(
      `SELECT test_case_id FROM automated_test_cases WHERE suite_id=$1 AND title=$2 AND test_case_id IS NOT NULL`,
      [run.suite_id, result.test_title]
    )
    const testCaseIds = rosterRows[0] ? [rosterRows[0].test_case_id] : []

    const newRun = await triggerHealRun({
      projectId: req.params.id,
      suiteId: run.suite_id,
      testCaseIds,
      targetTitle: result.test_title,
      filePath: file.path,
      userId: req.userId,
    })
    res.status(202).json(newRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// GET /suites/:suiteId/test-cases — the suite's automated test case roster,
// each row annotated with a GitHub link when a real generated file matches
// its tc-<id> title prefix. Staff + read-only clients who are project
// members (Malik confirmed clients should see the same view as staff here,
// unlike Generation History's PR/file links which stayed staff-only).
router.get('/suites/:suiteId/test-cases', ...anyProjectMember, async (req, res) => {
  try {
    const { rows: suiteRows } = await query(
      `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
      [req.params.suiteId, req.params.id]
    )
    const suite = suiteRows[0]
    if (!suite) return res.status(404).json({ error: 'Suite not found' })

    const { rows } = await query(`
      SELECT atc.id, atc.title, atc.origin, atc.review_status, atc.test_case_id,
        tc.title AS linked_test_case_title
      FROM automated_test_cases atc
      LEFT JOIN test_cases tc ON tc.id = atc.test_case_id
      WHERE atc.suite_id = $1
      ORDER BY atc.title
    `, [suite.id])

    const files = await listSuiteFiles(suite)
    const testCases = rows.map(r => ({ ...r, github_url: matchTestCaseToFile(r.title, files) }))

    res.json({ suite, testCases })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generated-test-cases — every AI-generated automated test case across
// every suite in the project, for the "Generated test cases" cross-suite
// view. Directory listing fetched once per distinct suite, not per row.
// Staff + read-only clients who are project members — same access level as
// the suite-scoped roster route above.
router.get('/generated-test-cases', ...anyProjectMember, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT atc.id, atc.title, atc.origin, atc.review_status, atc.test_case_id,
        tc.title AS linked_test_case_title,
        s.id AS suite_id, s.name AS suite_name, s.slug AS suite_slug, s.platform AS suite_platform
      FROM automated_test_cases atc
      JOIN automation_suites s ON s.id = atc.suite_id
      LEFT JOIN test_cases tc ON tc.id = atc.test_case_id
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
router.post('/runs/trigger', requireAuth, staffOnly, async (req, res) => {
  const { suite_id } = req.body
  if (!suite_id) return res.status(400).json({ error: 'suite_id is required' })

  try {
    const run = await triggerSuiteRun({ projectId: req.params.id, suiteId: suite_id, userId: req.userId })
    res.status(202).json(run)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// POST /generate — kick off a test GENERATION run (manual TCs -> agents -> PR)
router.post('/generate', requireAuth, staffOnly, async (req, res) => {
  const { suite_id, test_case_ids } = req.body
  if (!suite_id) return res.status(400).json({ error: 'suite_id is required' })

  try {
    const run = await triggerGenerationRun({
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

// GET /generation-runs — recent generation runs, newest first
router.get('/generation-runs', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleGenerationRuns(req.params.id)
    const { rows } = await query(`
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
      if (!r.pr_url) return r
      const prStatus = await getPrStatus(r.pr_url)
      return { ...r, pr_status: prStatus }
    }))
    res.json(withPrStatus)
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
    const { rows } = await query(
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2`,
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