import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db/pool.js'
import { requireAuth, requireRole, verifyToken } from '../middleware/auth.js'
import { subscribe, unsubscribe } from '../lib/sse.js'

const router = Router({ mergeParams: true })

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_WORKFLOW_ID = process.env.GITHUB_WORKFLOW_ID // e.g. "playwright.yml"

const staffOnly = [requireAuth, requireRole('qa_engineer', 'admin')]

// GET /suites — bucket cards with counts + latest run summary
router.get('/suites', ...staffOnly, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.*,
        COUNT(atc.id)::int AS test_case_count,
        latest.status AS latest_status,
        latest.passed AS latest_passed,
        latest.failed AS latest_failed,
        latest.completed_at AS latest_completed_at
      FROM automation_suites s
      LEFT JOIN automated_test_cases atc ON atc.suite_id = s.id
      LEFT JOIN LATERAL (
        SELECT * FROM test_runs tr
        WHERE tr.suite_id = s.id
        ORDER BY tr.started_at DESC
        LIMIT 1
      ) latest ON true
      WHERE s.project_id = $1
      GROUP BY s.id, latest.status, latest.passed, latest.failed, latest.completed_at
      ORDER BY s.name
    `, [req.params.id])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /suites — create a new suite bucket (e.g. "Regression")
router.post('/suites', ...staffOnly, async (req, res) => {
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
router.get('/runs', ...staffOnly, async (req, res) => {
  try {
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
router.get('/runs/:runId', ...staffOnly, async (req, res) => {
  try {
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
router.post('/runs/trigger', ...staffOnly, async (req, res) => {
  const { suite_id } = req.body
  if (!suite_id) return res.status(400).json({ error: 'suite_id is required' })
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !GITHUB_WORKFLOW_ID) {
    return res.status(500).json({ error: 'GitHub Actions is not configured on the server' })
  }

  try {
    const { rows: suiteRows } = await query(
      `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
      [suite_id, req.params.id]
    )
    if (!suiteRows[0]) return res.status(404).json({ error: 'Suite not found' })
    const suite = suiteRows[0]

    const correlationId = crypto.randomUUID()

    const { rows } = await query(
      `INSERT INTO test_runs (project_id, suite_id, correlation_id, trigger_type, status, created_by)
       VALUES ($1,$2,$3,'manual','pending',$4) RETURNING *`,
      [req.params.id, suite_id, correlationId, req.userId]
    )

    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'master',
          inputs: {
            suite_slug: suite.slug,
            run_correlation_id: correlationId,
          },
        }),
      }
    )

    if (!ghRes.ok) {
      const errText = await ghRes.text()
      await query(`UPDATE test_runs SET status='failed' WHERE id=$1`, [rows[0].id])
      return res.status(502).json({ error: `GitHub Actions dispatch failed: ${errText}` })
    }

    res.status(202).json(rows[0])
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
  if (!['qa_engineer', 'admin'].includes(decoded.role)) {
    return res.status(403).json({ error: "You don't have access to this resource" })
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