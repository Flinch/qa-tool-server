import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole, verifyToken } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'
import { subscribe, unsubscribe } from '../lib/sse.js'
import { triggerSuiteRun, reconcileStaleRuns, triggerGenerationRun, reconcileStaleGenerationRuns } from '../lib/automationTrigger.js'

const router = Router({ mergeParams: true })

const staffOnly = requireRole('qa_engineer', 'admin')
const anyProjectMember = [requireAuth, requireProjectAccess]

// GET /suites — bucket cards with counts + latest run summary. Staff +
// read-only clients who are project members.
router.get('/suites', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.params.id)
    const { rows } = await query(`
      SELECT s.*,
        COUNT(atc.id)::int AS test_case_count,
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
      GROUP BY s.id, latest.status, latest.passed, latest.failed, latest.started_at, latest.completed_at, latest.error_message
      ORDER BY latest.completed_at DESC NULLS LAST, s.name
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

// GET /runs — recent executions (optionally ?suite_id=)
router.get('/runs', ...anyProjectMember, async (req, res) => {
  try {
    await reconcileStaleRuns(req.params.id)
    const { suite_id } = req.query
    const params = [req.params.id]
    let filter = ''
    if (suite_id) {
      filter = 'AND tr.suite_id = $2'
      params.push(suite_id)
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

// GET /runs/:runId — detailed drill-down for one run
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

    const { rows: results } = await query(
      `SELECT * FROM test_run_results WHERE test_run_id=$1 ORDER BY id`,
      [req.params.runId]
    )
    res.json({ ...rows[0], results })
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
      SELECT gr.*, s.name AS suite_name, s.slug AS suite_slug
      FROM generation_runs gr
      JOIN automation_suites s ON s.id = gr.suite_id
      WHERE gr.project_id = $1
      ORDER BY gr.started_at DESC
      LIMIT 20
    `, [req.params.id])
    res.json(rows)
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