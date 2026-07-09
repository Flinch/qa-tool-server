import crypto from 'crypto'
import { query } from '../db/pool.js'
import { broadcast } from './sse.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_WORKFLOW_ID = process.env.GITHUB_WORKFLOW_ID // e.g. "playwright.yml"

// A run that's been sitting in pending/running this long almost certainly
// means CI never reported back (crashed runner, workflow misconfigured,
// webhook unreachable) rather than a genuinely slow suite. Flip it to
// failed so the client stops polling instead of waiting forever.
const STALE_RUN_TIMEOUT_MS = 10 * 60 * 1000

class TriggerError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Dispatches a suite run via GitHub Actions workflow_dispatch and records the
// pending test_runs row. Shared by the Automation page's "Run suite" action
// and by Execution Runs triggering a suite from inside a session.
export async function triggerSuiteRun({ projectId, suiteId, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !GITHUB_WORKFLOW_ID) {
    throw new TriggerError(500, 'GitHub Actions is not configured on the server')
  }

  const { rows: suiteRows } = await query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')
  const suite = suiteRows[0]

  const correlationId = crypto.randomUUID()

  const { rows } = await query(
    `INSERT INTO test_runs (project_id, suite_id, correlation_id, trigger_type, status, created_by)
     VALUES ($1,$2,$3,'manual','pending',$4) RETURNING *`,
    [projectId, suiteId, correlationId, userId]
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
    const errText = (await ghRes.text()).slice(0, 500)
    await query(
      `UPDATE test_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [rows[0].id, `GitHub Actions dispatch failed: ${errText}`]
    )
    throw new TriggerError(502, `GitHub Actions dispatch failed: ${errText}`)
  }

  return rows[0]
}

// Sweeps runs that have been pending/running past the timeout and marks them
// failed so a dropped webhook or a runner that never started doesn't leave
// the client polling indefinitely. Cheap idempotent UPDATE — safe to call on
// every read of run status.
export async function reconcileStaleRuns(projectId) {
  const { rows } = await query(
    `UPDATE test_runs
     SET status='failed', error_message='Timed out waiting for CI to report results', completed_at=NOW()
     WHERE project_id=$1 AND status IN ('pending','running')
       AND started_at < NOW() - ($2 * INTERVAL '1 millisecond')
     RETURNING id`,
    [projectId, STALE_RUN_TIMEOUT_MS]
  )
  for (const row of rows) broadcast(projectId, 'run_completed', { run_id: row.id })
  return rows
}
