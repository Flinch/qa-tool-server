import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { triggerSuiteRun, reconcileStaleRuns } from '../lib/automationTrigger.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireTenantAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

async function markInProgress(db, projectId, runId) {
  await db.query(
    `UPDATE execution_runs SET status='in_progress', started_at=COALESCE(started_at, NOW())
     WHERE id=$1 AND project_id=$2 AND status='not_started'`,
    [runId, projectId]
  )
}

// Confirms :runId in the URL actually belongs to :id (the tenant/project
// this request is scoped to) before any handler below touches it. Every
// mutation on a sub-resource of a run (a test-case-in-run status, a suite
// trigger) otherwise trusts req.params.runId as a bare id with no ownership
// check of its own — during Phase A's identity-resolver bridge (see
// tenantPool.js), every tenant still shares one physical database, so an
// unchecked runId could operate on a different project's execution run.
// Kept permanently after the bridge ends too: zero cost, real defense in
// depth against exactly the bug class this whole rework exists to close.
async function assertRunOwnership(db, projectId, runId) {
  const { rows } = await db.query(`SELECT id FROM execution_runs WHERE id=$1 AND project_id=$2`, [runId, projectId])
  return !!rows[0]
}

// GET / — execution runs for a project, with pass/fail/not-run/blocked + suite counts.
// Staff + read-only clients who are project members.
router.get('/', async (req, res) => {
  try {
    const { rows } = await req.db.query(`
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
  const { name, test_case_ids = [], suite_ids = [], platform } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (test_case_ids.length === 0 && suite_ids.length === 0) {
    return res.status(400).json({ error: 'Select at least one test case or automation suite' })
  }
  if (!platform) return res.status(400).json({ error: 'Platform is required' })
  if (!['web', 'ios', 'android'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })

  try {
    const { rows } = await req.db.query(
      `INSERT INTO execution_runs (project_id, name, created_by, platform) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name.trim(), req.userId, platform]
    )
    const run = rows[0]

    for (const tcId of test_case_ids) {
      await req.db.query(
        `INSERT INTO execution_run_test_cases (execution_run_id, test_case_id) VALUES ($1,$2)
         ON CONFLICT (execution_run_id, test_case_id) DO NOTHING`,
        [run.id, tcId]
      )
    }
    for (const suiteId of suite_ids) {
      await req.db.query(
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

// POST /:runId/re-execute — clone a run's exact test-case + suite selection
// into a brand-new run, for re-testing a release without rebuilding the
// selection from scratch. A test case that already passed carries that pass
// forward (no need to re-prove something that already worked); anything
// blocked/fail/not_run resets to not_run so it genuinely gets re-verified.
// Suites carry over as a bare selection with no latest_test_run_id — a suite
// run is a real CI dispatch, not something that can be "carried forward" as
// a result, so the new run always starts with its suites unrun.
router.post('/:runId/re-execute', staffOnly, async (req, res) => {
  try {
    const { rows: sourceRows } = await req.db.query(
      `SELECT * FROM execution_runs WHERE id=$1 AND project_id=$2`,
      [req.params.runId, req.params.id]
    )
    if (!sourceRows[0]) return res.status(404).json({ error: 'Execution run not found' })
    const source = sourceRows[0]

    const { rows: sourceTcs } = await req.db.query(
      `SELECT test_case_id, status FROM execution_run_test_cases WHERE execution_run_id=$1`,
      [req.params.runId]
    )
    const { rows: sourceSuites } = await req.db.query(
      `SELECT suite_id FROM execution_run_suites WHERE execution_run_id=$1`,
      [req.params.runId]
    )
    if (sourceTcs.length === 0 && sourceSuites.length === 0) {
      return res.status(400).json({ error: 'This run has no test cases or suites to re-execute' })
    }

    const { rows: newRunRows } = await req.db.query(
      `INSERT INTO execution_runs (project_id, name, created_by, platform) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, `${source.name} (re-execute)`, req.userId, source.platform]
    )
    const newRun = newRunRows[0]

    for (const tc of sourceTcs) {
      const carryingPass = tc.status === 'pass'
      await req.db.query(
        `INSERT INTO execution_run_test_cases (execution_run_id, test_case_id, status, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (execution_run_id, test_case_id) DO NOTHING`,
        [newRun.id, tc.test_case_id, carryingPass ? 'pass' : 'not_run', carryingPass ? `Carried over as passing from "${source.name}"` : null]
      )
    }
    for (const s of sourceSuites) {
      await req.db.query(
        `INSERT INTO execution_run_suites (execution_run_id, suite_id) VALUES ($1,$2)
         ON CONFLICT (execution_run_id, suite_id) DO NOTHING`,
        [newRun.id, s.suite_id]
      )
    }

    res.status(201).json(newRun)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /latest — the most recently created execution run for this project.
// Backs saved views of type 'execution_test_cases', which never pin a run
// id in their stored filters — they always reopen against whatever's most
// current, so a saved/shared view link never goes stale as new runs happen.
// Registered ahead of GET /:runId so Express doesn't swallow "latest" as a
// :runId value.
router.get('/latest', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id FROM execution_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'No execution runs yet' })
    res.json({ id: rows[0].id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /:runId — run + its test cases (with per-run status) + its suites (with latest run status).
// Staff + read-only clients who are project members.
router.get('/:runId', async (req, res) => {
  try {
    await reconcileStaleRuns(req.db, req.params.id)

    const { rows: runRows } = await req.db.query(
      `SELECT * FROM execution_runs WHERE id=$1 AND project_id=$2`,
      [req.params.runId, req.params.id]
    )
    if (!runRows[0]) return res.status(404).json({ error: 'Not found' })

    const { rows: testCases } = await req.db.query(`
      SELECT etc.id AS execution_test_case_id, etc.status, etc.notes, etc.executed_by, etc.executed_at,
        tc.id AS test_case_id, tc.title, tc.type, tc.steps, tc.expected, tc.feature_id,
        COUNT(b.id)::int AS bug_count
      FROM execution_run_test_cases etc
      JOIN test_cases tc ON tc.id = etc.test_case_id
      LEFT JOIN bugs b ON b.test_case_id = tc.id AND b.execution_run_id = etc.execution_run_id
      WHERE etc.execution_run_id = $1
      GROUP BY etc.id, tc.id
      ORDER BY tc.created_at
    `, [req.params.runId])

    // test_case_count prefers this run's actual tr.total over the
    // automated_test_cases roster — that roster is insert-only (webhooks.js
    // adds a title the first time it's seen but never removes one for a
    // renamed/deleted test), so it only ever grows and drifts from reality.
    // Falls back to the roster count for a suite that hasn't executed within
    // this specific execution run yet (tr.total is null until it has).
    const { rows: suites } = await req.db.query(`
      SELECT es.id AS execution_suite_id, es.suite_id, es.latest_test_run_id,
        s.name AS suite_name, s.slug AS suite_slug,
        COALESCE(tr.total, COUNT(atc.id)::int) AS test_case_count,
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
    const { rows } = await req.db.query(
      `UPDATE execution_runs SET ${fields.join(', ')} WHERE id=$${runIdParam} AND project_id=$${projectIdParam} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /:runId/test-cases/bulk — mark selected (or all) test cases at once.
// Registered ahead of PATCH /:runId/test-cases/:etcId below: Express
// matches routes in registration order, and :etcId is a wildcard segment
// that would otherwise swallow the literal path "bulk" too — every bulk
// request would hit the single-test-case handler with etcId='bulk' (which
// then 500s trying to cast 'bulk' to an integer), and this handler would
// never be reached at all. Same class of bug as GET /latest vs GET /:runId.
router.patch('/:runId/test-cases/bulk', staffOnly, async (req, res) => {
  const { ids, status } = req.body
  if (!['not_run', 'pass', 'fail', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

  try {
    if (!(await assertRunOwnership(req.db, req.params.id, req.params.runId))) {
      return res.status(404).json({ error: 'Not found' })
    }
    let rows
    if (ids === 'all') {
      ;({ rows } = await req.db.query(
        `UPDATE execution_run_test_cases SET status=$1, executed_by=$2, executed_at=NOW()
         WHERE execution_run_id=$3 RETURNING *`,
        [status, req.userId, req.params.runId]
      ))
    } else {
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array or "all"' })
      ;({ rows } = await req.db.query(
        `UPDATE execution_run_test_cases SET status=$1, executed_by=$2, executed_at=NOW()
         WHERE execution_run_id=$3 AND id = ANY($4::int[]) RETURNING *`,
        [status, req.userId, req.params.runId, ids]
      ))
    }
    await markInProgress(req.db, req.params.id, req.params.runId)
    res.json(rows)
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
    if (!(await assertRunOwnership(req.db, req.params.id, req.params.runId))) {
      return res.status(404).json({ error: 'Not found' })
    }
    const { rows } = await req.db.query(
      `UPDATE execution_run_test_cases SET ${fields.join(', ')}
       WHERE id=$${etcIdParam} AND execution_run_id=$${runIdParam}
       RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    await markInProgress(req.db, req.params.id, req.params.runId)
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:runId/suites/:suiteId/run — trigger a suite attached to this run via GitHub Actions
router.post('/:runId/suites/:suiteId/run', staffOnly, async (req, res) => {
  try {
    if (!(await assertRunOwnership(req.db, req.params.id, req.params.runId))) {
      return res.status(404).json({ error: 'Not found' })
    }
    const { rows: esRows } = await req.db.query(
      `SELECT * FROM execution_run_suites WHERE execution_run_id=$1 AND suite_id=$2`,
      [req.params.runId, req.params.suiteId]
    )
    if (!esRows[0]) return res.status(404).json({ error: 'Suite is not part of this execution run' })

    const testRun = await triggerSuiteRun({ db: req.db, tenantId: req.tenantId, projectId: req.params.id, suiteId: req.params.suiteId, userId: req.userId, triggeredFrom: 'executions_page' })

    await req.db.query(`UPDATE execution_run_suites SET latest_test_run_id=$1 WHERE id=$2`, [testRun.id, esRows[0].id])
    await markInProgress(req.db, req.params.id, req.params.runId)

    res.status(202).json(testRun)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// DELETE /:runId
router.delete('/:runId', staffOnly, async (req, res) => {
  try {
    const { rows } = await req.db.query(
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
