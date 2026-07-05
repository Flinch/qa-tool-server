import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db/pool.js'
import { broadcast } from '../lib/sse.js'

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

router.post('/test-runs', verifySecret, async (req, res) => {
  const {
    correlation_id, project_id, suite_slug, trigger_type,
    status, total, passed, failed, skipped, duration_ms,
    report_url, github_run_url, results = [],
  } = req.body

  if (!project_id || !suite_slug || !status) {
    return res.status(400).json({ error: 'project_id, suite_slug, and status are required' })
  }

  try {
    const { rows: suiteRows } = await query(
      `SELECT id FROM automation_suites WHERE project_id=$1 AND slug=$2`,
      [project_id, suite_slug]
    )
    if (!suiteRows[0]) return res.status(404).json({ error: 'Unknown suite for this project' })
    const suiteId = suiteRows[0].id

    let runId

    if (correlation_id) {
      const { rows } = await query(
        `UPDATE test_runs
         SET status=$1, total=$2, passed=$3, failed=$4, skipped=$5,
             duration_ms=$6, report_url=$7, github_run_url=$8, completed_at=NOW()
         WHERE correlation_id=$9
         RETURNING id`,
        [status, total, passed, failed, skipped, duration_ms, report_url, github_run_url, correlation_id]
      )
      runId = rows[0]?.id
    }

    if (!runId) {
      const { rows } = await query(
        `INSERT INTO test_runs
           (project_id, suite_id, trigger_type, status, total, passed, failed, skipped,
            duration_ms, report_url, github_run_url, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         RETURNING id`,
        [project_id, suiteId, trigger_type || 'nightly', status, total, passed, failed, skipped,
         duration_ms, report_url, github_run_url]
      )
      runId = rows[0].id
    }

    for (const r of results) {
      await query(
        `INSERT INTO test_run_results (test_run_id, test_title, status, duration_ms, error_message)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, r.test_title, r.status, r.duration_ms != null ? Math.round(r.duration_ms) : null, r.error_message || null]
      )
    }

    broadcast(project_id, 'run_completed', { run_id: runId })

    res.status(200).json({ received: true, run_id: runId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router