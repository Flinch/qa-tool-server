import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'
import { triggerSuiteRun, reconcileStaleRuns } from '../lib/automationTrigger.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireProjectAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

async function markInProgress(runId) {
  await query(
    `UPDATE execution_runs SET status='in_progress', started_at=COALESCE(started_at, NOW())
     WHERE id=$1 AND status='not_started'`,
    [runId]
  )
}

// GET / — execution runs for a project, with pass/fail/not-run/blocked + suite counts.
// Staff + read-only clients who are project members.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT er.*,
        COUNT(DISTINCT etc.id)::int AS total_test_cases,
        COUNT(DISTINCT etc.id) FILTER (WHERE etc.status='pass')::int AS passed,
        COUNT(DISTINCT etc.id) FILTER (WHERE etc.status='fail')::int AS failed,
        COUNT(DISTINCT etc.id) FILTER (WHERE etc.status='not_run')::int AS not_run,
        COUNT(DISTINCT etc.id) FILTER (WHERE etc.status='blocked')::int AS blocked,
        COUNT(DISTINCT es.id)::int AS suite_count
      FROM execution_runs er
      LEFT JOIN execution_run_test_cases etc ON etc.execution_run_id = er.id
      LEFT JOIN execution_run_suites es ON es.execution_run_id = er.id
      WHERE er.project_id = $1
      GROUP BY er.id
      ORDER BY er.created_at DESC
    `, [req.params.id])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST / — create a run from a selection of test cases + automation suites
router.post('/', staffOnly, async (req, res) => {
  const { name, test_case_ids = [], suite_ids = [] } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (test_case_ids.length === 0 && suite_ids.length === 0) {
    return res.status(400).json({ error: 'Select at least one test case or automation suite' })
  }

  try {
    const { rows } = await query(
      `INSERT INTO execution_runs (project_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, name.trim(), req.userId]
    )
    const run = rows[0]

    for (const tcId of test_case_ids) {
      await query(
        `INSERT INTO execution_run_test_cases (execution_run_id, test_case_id) VALUES ($1,$2)
         ON CONFLICT (execution_run_id, test_case_id) DO NOTHING`,
        [run.id, tcId]
      )
    }
    for (const suiteId of suite_ids) {
      await query(
        `INSERT INTO execution_run_suites (execution_run_id, suite_id) VALUES ($1,$2)
         ON CONFLICT (execution_run_id, suite_id) DO NOTHING`,
        [run.id, suiteId]
      )
    }

    res.status(201).json(run)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /:runId — run + its test cases (with per-run status) + its suites (with latest run status).
// Staff + read-only clients who are project members.
router.get('/:runId', async (req, res) => {
  try {
    await reconcileStaleRuns(req.params.id)

    const { rows: runRows } = await query(
      `SELECT * FROM execution_runs WHERE id=$1 AND project_id=$2`,
      [req.params.runId, req.params.id]
    )
    if (!runRows[0]) return res.status(404).json({ error: 'Not found' })

    const { rows: testCases } = await query(`
      SELECT etc.id AS execution_test_case_id, etc.status, etc.notes, etc.executed_by, etc.executed_at,
        tc.id AS test_case_id, tc.title, tc.type, tc.steps, tc.expected,
        COUNT(b.id)::int AS bug_count
      FROM execution_run_test_cases etc
      JOIN test_cases tc ON tc.id = etc.test_case_id
      LEFT JOIN bugs b ON b.test_case_id = tc.id AND b.execution_run_id = etc.execution_run_id
      WHERE etc.execution_run_id = $1
      GROUP BY etc.id, tc.id
      ORDER BY tc.created_at
    `, [req.params.runId])

    // test_case_count (current suite membership) is separate from tr.total
    // (how many tests the *last run* actually covered) — the two can drift
    // if suite membership changed since the last run. Both are exposed so
    // the client can decide which one a given number means (e.g. "total
    // tests in this run" wants test_case_count even for a suite that
    // hasn't executed yet, not the null-until-run tr.total).
    const { rows: suites } = await query(`
      SELECT es.id AS execution_suite_id, es.suite_id, es.latest_test_run_id,
        s.name AS suite_name, s.slug AS suite_slug,
        COUNT(atc.id)::int AS test_case_count,
        tr.status AS latest_status, tr.total, tr.passed, tr.failed, tr.skipped,
        tr.duration_ms, tr.report_url, tr.github_run_url,
        tr.started_at AS latest_started_at, tr.completed_at AS latest_completed_at,
        tr.error_message AS latest_error_message
      FROM execution_run_suites es
      JOIN automation_suites s ON s.id = es.suite_id
      LEFT JOIN automated_test_cases atc ON atc.suite_id = s.id
      LEFT JOIN test_runs tr ON tr.id = es.latest_test_run_id
      WHERE es.execution_run_id = $1
      GROUP BY es.id, s.name, s.slug, tr.status, tr.total, tr.passed, tr.failed, tr.skipped,
        tr.duration_ms, tr.report_url, tr.github_run_url, tr.started_at, tr.completed_at, tr.error_message
      ORDER BY s.name
    `, [req.params.runId])

    res.json({ ...runRows[0], test_cases: testCases, suites })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /:runId — rename and/or change run status (e.g. mark completed)
router.patch('/:runId', staffOnly, async (req, res) => {
  const { name, status } = req.body
  const fields = []
  const values = []
  let i = 1

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
    fields.push(`name=$${i++}`); values.push(name.trim())
  }
  if (status !== undefined) {
    if (!['not_started', 'in_progress', 'completed'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    fields.push(`status=$${i++}`); values.push(status)
    if (status === 'completed') fields.push(`completed_at=NOW()`)
    if (status === 'in_progress') fields.push(`started_at=COALESCE(started_at, NOW())`)
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  values.push(req.params.runId)
  const runIdParam = i++
  values.push(req.params.id)
  const projectIdParam = i++

  try {
    const { rows } = await query(
      `UPDATE execution_runs SET ${fields.join(', ')} WHERE id=$${runIdParam} AND project_id=$${projectIdParam} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /:runId/test-cases/:etcId — mark one test case pass/fail/blocked/not_run
router.patch('/:runId/test-cases/:etcId', staffOnly, async (req, res) => {
  const { status, notes } = req.body
  if (status !== undefined && !['not_run', 'pass', 'fail', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }

  const fields = []
  const values = []
  let i = 1
  if (status !== undefined) {
    fields.push(`status=$${i++}`); values.push(status)
    fields.push(`executed_by=$${i++}`); values.push(req.userId)
    fields.push(`executed_at=NOW()`)
  }
  if (notes !== undefined) {
    fields.push(`notes=$${i++}`); values.push(notes)
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  values.push(req.params.etcId)
  const etcIdParam = i++
  values.push(req.params.runId)
  const runIdParam = i++

  try {
    const { rows } = await query(
      `UPDATE execution_run_test_cases SET ${fields.join(', ')}
       WHERE id=$${etcIdParam} AND execution_run_id=$${runIdParam}
       RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    await markInProgress(req.params.runId)
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /:runId/test-cases/bulk — mark selected (or all) test cases at once
router.patch('/:runId/test-cases/bulk', staffOnly, async (req, res) => {
  const { ids, status } = req.body
  if (!['not_run', 'pass', 'fail', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

  try {
    let rows
    if (ids === 'all') {
      ;({ rows } = await query(
        `UPDATE execution_run_test_cases SET status=$1, executed_by=$2, executed_at=NOW()
         WHERE execution_run_id=$3 RETURNING *`,
        [status, req.userId, req.params.runId]
      ))
    } else {
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array or "all"' })
      ;({ rows } = await query(
        `UPDATE execution_run_test_cases SET status=$1, executed_by=$2, executed_at=NOW()
         WHERE execution_run_id=$3 AND id = ANY($4::int[]) RETURNING *`,
        [status, req.userId, req.params.runId, ids]
      ))
    }
    await markInProgress(req.params.runId)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:runId/suites/:suiteId/run — trigger a suite attached to this run via GitHub Actions
router.post('/:runId/suites/:suiteId/run', staffOnly, async (req, res) => {
  try {
    const { rows: esRows } = await query(
      `SELECT * FROM execution_run_suites WHERE execution_run_id=$1 AND suite_id=$2`,
      [req.params.runId, req.params.suiteId]
    )
    if (!esRows[0]) return res.status(404).json({ error: 'Suite is not part of this execution run' })

    const testRun = await triggerSuiteRun({ projectId: req.params.id, suiteId: req.params.suiteId, userId: req.userId })

    await query(`UPDATE execution_run_suites SET latest_test_run_id=$1 WHERE id=$2`, [testRun.id, esRows[0].id])
    await markInProgress(req.params.runId)

    res.status(202).json(testRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// DELETE /:runId
router.delete('/:runId', staffOnly, async (req, res) => {
  try {
    const { rows } = await query(
      `DELETE FROM execution_runs WHERE id=$1 AND project_id=$2 RETURNING id`,
      [req.params.runId, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
