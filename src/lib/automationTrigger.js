import crypto from 'crypto'
import { query } from '../db/pool.js'
import { broadcast } from './sse.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_WORKFLOW_ID = process.env.GITHUB_WORKFLOW_ID // e.g. "playwright.yml"
// Separate workflow file for test GENERATION (agents -> PR). Kept as its own
// env var so the two pipelines can evolve independently.
const GITHUB_GENERATION_WORKFLOW_ID = process.env.GITHUB_GENERATION_WORKFLOW_ID // e.g. "generate-tests.yml"

// A run that's been sitting in pending/running this long almost certainly
// means CI never reported back (crashed runner, workflow misconfigured,
// webhook unreachable) rather than a genuinely slow suite. Flip it to
// failed so the client stops polling instead of waiting forever.
const STALE_RUN_TIMEOUT_MS = 10 * 60 * 1000

// Generation runs get a much longer leash than test runs: the agent workflow
// legitimately takes 15-30+ minutes (browser exploration + codegen + heal
// iterations) and has a 45-minute timeout in the workflow file itself. The
// sweep window MUST outlast the workflow timeout — if the sweep were shorter,
// a slow-but-succeeding run would get marked failed here, and then its
// completion webhook would arrive for a row we already declared dead.
// 60 min = 45 min workflow cap + queue time + margin.
const STALE_GENERATION_TIMEOUT_MS = 60 * 60 * 1000

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

// Dispatches a test GENERATION run: manual test cases -> Playwright agents in
// CI -> pull request. Mirrors triggerSuiteRun's shape on purpose (insert row
// first, dispatch, mark failed on dispatch error) so the two flows stay easy
// to reason about side by side.
//
// Note what we do NOT send to GitHub: the test cases themselves.
// workflow_dispatch inputs are limited (max 10 properties, small values), and
// a batch of TCs with steps JSONB would blow past that. So the dispatch
// carries ONLY the correlation id, and the workflow calls back to
// GET /api/webhooks/generation-payload/:correlationId to fetch the plans.
// Single source of truth stays in Postgres; CI pulls what it needs.
export async function triggerGenerationRun({ projectId, suiteId, testCaseIds, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !GITHUB_GENERATION_WORKFLOW_ID) {
    throw new TriggerError(500, 'Test generation workflow is not configured on the server')
  }
  if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
    throw new TriggerError(400, 'testCaseIds must be a non-empty array')
  }

  const { rows: suiteRows } = await query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')

  // Validate the selection server-side: every id must be a real TC in THIS
  // project AND flagged as an automation candidate. Never trust the client's
  // filter — a stale UI or a hand-crafted request could send anything.
  const { rows: tcRows } = await query(
    `SELECT id FROM test_cases
     WHERE project_id=$1 AND id = ANY($2::int[]) AND automation_candidate = true`,
    [projectId, testCaseIds]
  )
  if (tcRows.length !== testCaseIds.length) {
    const validIds = new Set(tcRows.map(r => r.id))
    const rejected = testCaseIds.filter(id => !validIds.has(id))
    throw new TriggerError(
      400,
      `Test cases not found in this project or not automation candidates: ${rejected.join(', ')}`
    )
  }

  const correlationId = crypto.randomUUID()

  // Row goes in BEFORE the dispatch. If the dispatch fails we have somewhere
  // to record the error; if the server crashed between insert and dispatch,
  // the generation sweep would eventually mark the orphaned 'pending' row
  // failed. The alternative order (dispatch first) is worse: a run could be
  // executing in CI with no row for its webhooks to land on.
  const { rows } = await query(
    `INSERT INTO generation_runs (project_id, suite_id, correlation_id, status, test_case_ids, created_by)
     VALUES ($1,$2,$3,'pending',$4,$5) RETURNING *`,
    [projectId, suiteId, correlationId, testCaseIds, userId]
  )

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_GENERATION_WORKFLOW_ID}/dispatches`,
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
          correlation_id: correlationId,
        },
      }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await query(
      `UPDATE generation_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
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

// Same idea for generation runs, with the longer window and the full list of
// non-terminal states. IMPORTANT: this is a separate function on a separate
// table precisely so the 10-minute test_runs sweep above can never touch a
// 25-minute generation run mid-flight.
//
// The race worth understanding (this is why the WHERE clause is written the
// way it is): CI's completion webhook and this sweep can fire at the same
// moment for the same row. Postgres row-level locking means one UPDATE wins
// and the other waits, so there are exactly two orderings:
//
//   1. Webhook first: row becomes 'completed'. Sweep then runs, but its
//      WHERE status IN (...non-terminal...) no longer matches -> sweep
//      touches nothing. Correct.
//   2. Sweep first: row becomes 'failed' (it WAS past the deadline). The
//      webhook handler then updates it to 'completed' — which is fine and
//      even desirable: real results beat a timeout guess. (This is also why
//      the webhook handler should not refuse to update 'failed' rows.)
//
// Either ordering converges on a sane terminal state because both writers
// are plain conditional UPDATEs — no read-then-write gap to get wrong.
export async function reconcileStaleGenerationRuns(projectId) {
  const { rows } = await query(
    `UPDATE generation_runs
     SET status='failed',
         error_message='Timed out waiting for the generation workflow to report back',
         completed_at=NOW()
     WHERE project_id=$1
       AND status IN ('pending','exploring','generating','healing','opening_pr')
       AND started_at < NOW() - ($2 * INTERVAL '1 millisecond')
     RETURNING id`,
    [projectId, STALE_GENERATION_TIMEOUT_MS]
  )
  // Same SSE pattern as reconcileStaleRuns: tell any open Automation page
  // that these runs reached a terminal state so it can re-fetch. The client
  // will subscribe to this event name in Phase 3.
  for (const row of rows) broadcast(projectId, 'generation_completed', { generation_run_id: row.id })
  return rows
}