import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db/pool.js'
import { broadcast } from '../lib/sse.js'
import { exportPlansForTestCases } from '../lib/planExport.js'

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
             duration_ms=$6, report_url=$7, github_run_url=$8, error_message=$9, completed_at=NOW()
         WHERE correlation_id=$10
         RETURNING id`,
        [status, total, passed, failed, skipped, duration_ms, report_url, github_run_url, error_message || null, correlation_id]
      )
      runId = rows[0]?.id
    }

    if (!runId) {
      const { rows } = await query(
        `INSERT INTO test_runs
           (project_id, suite_id, trigger_type, status, total, passed, failed, skipped,
            duration_ms, report_url, github_run_url, error_message, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         RETURNING id`,
        [project_id, suiteId, trigger_type || 'nightly', status, total, passed, failed, skipped,
         duration_ms, report_url, github_run_url, error_message || null]
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

    // Keep the suite's known test roster in sync with what actually ran.
    // New test titles get added automatically; renamed/removed ones just
    // stop showing up in future runs rather than being deleted here.
    for (const r of results) {
      await query(
        `INSERT INTO automated_test_cases (suite_id, title)
         VALUES ($1, $2)
         ON CONFLICT (suite_id, title) DO NOTHING`,
        [suiteId, r.test_title]
      )
    }

    broadcast(project_id, 'run_completed', { run_id: runId })

    res.status(200).json({ received: true, run_id: runId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generation-payload/:correlationId — CI calls this back after
// workflow_dispatch to fetch the plans it needs (see automationTrigger.js
// for why only a correlation id crosses the dispatch boundary).
router.get('/generation-payload/:correlationId', verifySecret, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT gr.*, s.slug AS suite_slug
       FROM generation_runs gr
       JOIN automation_suites s ON s.id = gr.suite_id
       WHERE gr.correlation_id = $1`,
      [req.params.correlationId]
    )
    const run = rows[0]
    if (!run) return res.status(404).json({ error: 'Unknown correlation id' })

    // CI fetching the payload is the moment work actually begins.
    if (run.status === 'pending') {
      await query(`UPDATE generation_runs SET status='exploring' WHERE id=$1`, [run.id])
      broadcast(run.project_id, 'generation_progress', { generation_run_id: run.id, status: 'exploring' })
    }

    res.json({
      project_id: run.project_id,
      suite_id: run.suite_id,
      suite_slug: run.suite_slug,
      target_url: process.env.TARGET_URL || 'https://service-desk-roan.vercel.app',
      plans: await exportPlansForTestCases(run.project_id, run.test_case_ids),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /generation-events — CI reports phase progress + completion here as
// the agent workflow moves through its phases.
router.post('/generation-events', verifySecret, async (req, res) => {
  const { correlation_id, status, pr_url, branch_name, error_message } = req.body

  if (!GENERATION_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${GENERATION_STATUSES.join(', ')}` })
  }

  try {
    const { rows: existing } = await query(
      `SELECT id FROM generation_runs WHERE correlation_id=$1`,
      [correlation_id]
    )
    if (!existing[0]) return res.status(404).json({ error: 'Unknown correlation id' })

    const isTerminal = status === 'completed' || status === 'failed'

    // No WHERE status guard: a completion webhook must be able to overwrite
    // a row the stale-run sweep already marked 'failed' — real results beat
    // a timeout guess (see reconcileStaleGenerationRuns for the full race).
    const { rows } = await query(
      `UPDATE generation_runs
       SET status=$1,
           pr_url=COALESCE($2, pr_url),
           branch_name=COALESCE($3, branch_name),
           error_message=$4,
           completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END
       WHERE correlation_id=$6
       RETURNING id, project_id, pr_url`,
      [status, pr_url || null, branch_name || null, error_message || null, isTerminal, correlation_id]
    )
    const run = rows[0]

    broadcast(run.project_id, 'generation_progress', { generation_run_id: run.id, status, pr_url: run.pr_url })
    if (isTerminal) {
      broadcast(run.project_id, 'generation_completed', { generation_run_id: run.id })
    }

    res.status(200).json({ received: true, generation_run_id: run.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router