import crypto from 'crypto'
import { query } from '../db/pool.js' // control-plane pool from here on
import { broadcast } from './sse.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_WORKFLOW_ID = process.env.GITHUB_WORKFLOW_ID // e.g. "playwright.yml"
// Separate workflow file for test GENERATION (agents -> PR). Kept as its own
// env var so the two pipelines can evolve independently.
const GITHUB_GENERATION_WORKFLOW_ID = process.env.GITHUB_GENERATION_WORKFLOW_ID // e.g. "generate-tests.yml"
// Mobile generation runs on a self-hosted runner against a real device, so it
// gets its own workflow file rather than sharing the web one.
const GITHUB_MOBILE_GENERATION_WORKFLOW_ID = process.env.GITHUB_MOBILE_GENERATION_WORKFLOW_ID // e.g. "generate-mobile-tests.yml"
// workflow_dispatch only finds a workflow file that already exists on the
// ref being dispatched against. Defaults to 'master' like every other
// dispatch here; override while the mobile workflow file lives on a branch
// that hasn't merged yet.
const GITHUB_MOBILE_GENERATION_REF = process.env.GITHUB_MOBILE_GENERATION_REF || 'master'
// Mobile suite EXECUTION (running already-generated, already-reviewed Maestro
// flows — not authoring them) gets its own workflow too, separate from
// GITHUB_MOBILE_GENERATION_WORKFLOW_ID, same reasoning as the web/mobile split
// above: no agents, no cost cap, just `maestro test` against a real device.
const GITHUB_MOBILE_WORKFLOW_ID = process.env.GITHUB_MOBILE_WORKFLOW_ID // e.g. "maestro-run.yml"
const GITHUB_MOBILE_REF = process.env.GITHUB_MOBILE_REF || 'master'
// "Diagnose and heal" a single already-existing failing test — its own
// workflow per platform, same web/mobile split as every other pipeline here.
const GITHUB_HEAL_WORKFLOW_ID = process.env.GITHUB_HEAL_WORKFLOW_ID // e.g. "heal-test.yml"
const GITHUB_MOBILE_HEAL_WORKFLOW_ID = process.env.GITHUB_MOBILE_HEAL_WORKFLOW_ID // e.g. "heal-mobile-test.yml"
// Generates and PR-gates a project's per-project login flow (see
// tests/auth-setups/, lib/authSetupStatus.js). Web-only — there's no
// login-flow concept for mobile's self-contained Maestro flows.
const GITHUB_AUTH_SETUP_WORKFLOW_ID = process.env.GITHUB_AUTH_SETUP_WORKFLOW_ID // e.g. "generate-auth-setup.yml"

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

// The mechanism that lets a webhook resolve which tenant DB a result belongs
// to WITHOUT trusting anything CI claims about project_id — see
// dispatch_index in controlPlaneSchema.js. Written to the control plane
// AFTER the tenant DB's own pending row exists (so a crash before this call
// just means nothing was dispatched yet — harmless) and BEFORE the GitHub
// Actions dispatch fetch() (so a crash after this call but before dispatch
// is equally harmless: an orphan index row pointing at a run that was never
// actually kicked off). There is no ordering that leaves a REAL dispatched
// run unable to resolve its tenant.
async function recordDispatch(correlationId, tenantId, kind) {
  await query(
    `INSERT INTO dispatch_index (correlation_id, tenant_id, kind) VALUES ($1,$2,$3)`,
    [correlationId, tenantId, kind]
  )
}

// Dispatches a suite run via GitHub Actions workflow_dispatch and records the
// pending test_runs row. Shared by the Automation page's "Run suite" action
// and by Execution Runs triggering a suite from inside a session. `db` is
// the caller's tenant pool (from req.db); `tenantId` is that same tenant's
// control-plane id (equal to `projectId` by design — see "tenant id ==
// project id" in the Phase A plan — kept as a separate param so call sites
// stay explicit about which system each value is for).
export async function triggerSuiteRun({ db, tenantId, projectId, suiteId, userId, triggerType = 'manual' }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new TriggerError(500, 'GitHub Actions is not configured on the server')
  }

  const { rows: suiteRows } = await db.query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')
  const suite = suiteRows[0]

  // Route to the right execution workflow by platform, same reasoning as
  // triggerGenerationRun's routing below.
  const workflowId = suite.platform === 'web' ? GITHUB_WORKFLOW_ID : GITHUB_MOBILE_WORKFLOW_ID
  if (!workflowId) {
    throw new TriggerError(500, `No run workflow configured for "${suite.platform}" suites`)
  }

  const correlationId = crypto.randomUUID()

  const { rows } = await db.query(
    `INSERT INTO test_runs (project_id, suite_id, correlation_id, trigger_type, status, created_by)
     VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
    [projectId, suiteId, correlationId, triggerType, userId]
  )
  await recordDispatch(correlationId, tenantId, 'test_run')

  // Web dispatch inputs must match playwright.yml's declared inputs exactly
  // (workflow_dispatch rejects undeclared ones) — project_id isn't one of
  // them there, since the web pipeline still relies on the single
  // QA_TOOL_PROJECT_ID repo variable (routing no longer depends on that
  // value being correct now that dispatch_index exists, but the input
  // itself is still unused by playwright.yml, so it stays omitted here).
  // Mobile already spans more than one project, so maestro-run.yml takes
  // project_id and platform explicitly.
  const ref = suite.platform === 'web' ? 'master' : GITHUB_MOBILE_REF
  const inputs = suite.platform === 'web'
    ? { suite_slug: suite.slug, run_correlation_id: correlationId }
    : { suite_slug: suite.slug, platform: suite.platform, project_id: String(projectId), run_correlation_id: correlationId }

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await db.query(
      `UPDATE test_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [rows[0].id, `GitHub Actions dispatch failed: ${errText}`]
    )
    throw new TriggerError(502, `GitHub Actions dispatch failed: ${errText}`)
  }

  return rows[0]
}

// Dispatches a diagnostic re-run of SPECIFIC previously-failed test files,
// not the whole suite. Mirrors triggerSuiteRun almost exactly (same suite
// lookup, same dispatch shape, same pending-row-before-dispatch ordering) —
// the only real differences are scope='test_cases' on the inserted row (so
// GET /runs can hide these from clients) and the extra file_paths dispatch
// input both workflows now understand. Getting its own fresh correlation_id
// and its own INSERTed row means the webhook that reports results back can
// only ever UPDATE this new row — the run being diagnosed is never touched.
export async function triggerTestCaseRerun({ db, tenantId, projectId, suiteId, filePaths, targetTitles, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new TriggerError(500, 'GitHub Actions is not configured on the server')
  }

  const { rows: suiteRows } = await db.query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')
  const suite = suiteRows[0]

  const workflowId = suite.platform === 'web' ? GITHUB_WORKFLOW_ID : GITHUB_MOBILE_WORKFLOW_ID
  if (!workflowId) {
    throw new TriggerError(500, `No run workflow configured for "${suite.platform}" suites`)
  }

  const correlationId = crypto.randomUUID()

  const { rows } = await db.query(
    `INSERT INTO test_runs (project_id, suite_id, correlation_id, trigger_type, status, scope, target_titles, created_by)
     VALUES ($1,$2,$3,'manual','pending','test_cases',$4,$5) RETURNING *`,
    [projectId, suiteId, correlationId, targetTitles || [], userId]
  )
  await recordDispatch(correlationId, tenantId, 'test_run')

  const ref = suite.platform === 'web' ? 'master' : GITHUB_MOBILE_REF
  const filePathsInput = filePaths.join(' ')
  const inputs = suite.platform === 'web'
    ? { suite_slug: suite.slug, run_correlation_id: correlationId, file_paths: filePathsInput }
    : { suite_slug: suite.slug, platform: suite.platform, project_id: String(projectId), run_correlation_id: correlationId, file_paths: filePathsInput }

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await db.query(
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
export async function triggerGenerationRun({ db, tenantId, projectId, suiteId, testCaseIds, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new TriggerError(500, 'Test generation workflow is not configured on the server')
  }
  if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
    throw new TriggerError(400, 'testCaseIds must be a non-empty array')
  }
  // Batches beyond ~3 TCs risk hitting the CI job's wall-clock/timeout budget
  // before finishing (each TC still needs real live browser turns regardless
  // of batching) — enforced server-side too so this can't be bypassed by a
  // raw API call, not just disabled checkboxes in the UI.
  if (testCaseIds.length > 3) {
    throw new TriggerError(400, 'A maximum of 3 test cases can be batched into one generation run')
  }

  const { rows: suiteRows } = await db.query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')

  // Route to the right generation workflow by platform — each engine's agents
  // and target (URL vs. device+app) are different enough to need their own
  // CI workflow, same reasoning as triggerSuiteRun's per-platform dispatch.
  const workflowId = suiteRows[0].platform === 'web' ? GITHUB_GENERATION_WORKFLOW_ID : GITHUB_MOBILE_GENERATION_WORKFLOW_ID
  if (!workflowId) {
    throw new TriggerError(500, `No generation workflow configured for "${suiteRows[0].platform}" suites`)
  }

  // Validate the selection server-side: every id must be a real TC in THIS
  // project, flagged as an automation candidate, AND tagged for the same
  // platform category as the target suite. Never trust the client's filter —
  // a stale UI or a hand-crafted request could send anything. test_cases.
  // platform is coarse (web/mobile), unlike automation_suites.platform
  // (web/ios/android) — both ios and android suites accept 'mobile' TCs; see
  // migrate.js's platform-segmentation comment for why that's intentional,
  // not a precision loss (a requirement can legitimately cover both mobile
  // OSes via separate TC rows).
  const suiteCategory = suiteRows[0].platform === 'web' ? 'web' : 'mobile'
  const { rows: tcRows } = await db.query(
    `SELECT id FROM test_cases
     WHERE project_id=$1 AND id = ANY($2::int[]) AND automation_candidate = true AND platform = $3`,
    [projectId, testCaseIds, suiteCategory]
  )
  if (tcRows.length !== testCaseIds.length) {
    const validIds = new Set(tcRows.map(r => r.id))
    const rejected = testCaseIds.filter(id => !validIds.has(id))
    throw new TriggerError(
      400,
      `Test cases not found, not automation candidates, or not "${suiteCategory}" platform: ${rejected.join(', ')}`
    )
  }

  const correlationId = crypto.randomUUID()

  // Row goes in BEFORE the dispatch. If the dispatch fails we have somewhere
  // to record the error; if the server crashed between insert and dispatch,
  // the generation sweep would eventually mark the orphaned 'pending' row
  // failed. The alternative order (dispatch first) is worse: a run could be
  // executing in CI with no row for its webhooks to land on.
  const { rows } = await db.query(
    `INSERT INTO generation_runs (project_id, suite_id, correlation_id, status, test_case_ids, created_by)
     VALUES ($1,$2,$3,'pending',$4,$5) RETURNING *`,
    [projectId, suiteId, correlationId, testCaseIds, userId]
  )
  await recordDispatch(correlationId, tenantId, 'generation_run')

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: suiteRows[0].platform === 'web' ? 'master' : GITHUB_MOBILE_GENERATION_REF,
        inputs: {
          correlation_id: correlationId,
        },
      }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await db.query(
      `UPDATE generation_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [rows[0].id, `GitHub Actions dispatch failed: ${errText}`]
    )
    throw new TriggerError(502, `GitHub Actions dispatch failed: ${errText}`)
  }

  return rows[0]
}

// Dispatches a one-off "diagnose and heal" at a SINGLE already-existing
// failing test file — not a batch generation run. Reuses the exact same
// generation_runs table and generation-events webhook lifecycle as
// triggerGenerationRun above (kind='heal' is the only real difference in the
// row itself), so the client's existing generation-run live-progress
// tracking picks this up for free. testCaseIds is best-effort (0 or 1
// elements — a real linked test case if the failing result resolved to one,
// empty if it's an orphan title with no tc-<id> match) since healing doesn't
// require the stricter link triggerGenerationRun enforces.
export async function triggerHealRun({ db, tenantId, projectId, suiteId, testCaseIds, targetTitle, filePath, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new TriggerError(500, 'Test generation workflow is not configured on the server')
  }

  const { rows: suiteRows } = await db.query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')
  const suite = suiteRows[0]

  const workflowId = suite.platform === 'web' ? GITHUB_HEAL_WORKFLOW_ID : GITHUB_MOBILE_HEAL_WORKFLOW_ID
  if (!workflowId) {
    throw new TriggerError(500, `No heal workflow configured for "${suite.platform}" suites`)
  }

  const correlationId = crypto.randomUUID()

  const { rows } = await db.query(
    `INSERT INTO generation_runs (project_id, suite_id, correlation_id, status, kind, target_title, test_case_ids, created_by)
     VALUES ($1,$2,$3,'pending','heal',$4,$5,$6) RETURNING *`,
    [projectId, suiteId, correlationId, targetTitle, testCaseIds || [], userId]
  )
  await recordDispatch(correlationId, tenantId, 'generation_run')

  const ref = suite.platform === 'web' ? 'master' : GITHUB_MOBILE_GENERATION_REF
  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: {
          correlation_id: correlationId,
          file_path: filePath,
        },
      }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await db.query(
      `UPDATE generation_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [rows[0].id, `GitHub Actions dispatch failed: ${errText}`]
    )
    throw new TriggerError(502, `GitHub Actions dispatch failed: ${errText}`)
  }

  return rows[0]
}

// Generates this project's per-project login flow (tests/auth-setups/) from
// its configured target_url/credentials, runs it for real inside CI, and
// opens a PR — see lib/authSetupStatus.js for how the resulting run gates
// regular generation/execution until that PR is merged. Modeled directly on
// triggerHealRun above: same dispatch mechanics, no suite/test-case ids
// (this isn't suite-scoped — suite_id stays NULL).
export async function triggerAuthSetupRun({ db, tenantId, projectId, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new TriggerError(500, 'Test generation workflow is not configured on the server')
  }
  if (!GITHUB_AUTH_SETUP_WORKFLOW_ID) {
    throw new TriggerError(500, 'No auth-setup generation workflow configured')
  }

  const { rows: configRows } = await db.query(
    `SELECT target_url FROM project_test_config WHERE project_id=$1`,
    [projectId]
  )
  const targetUrl = configRows[0]?.target_url
  if (!targetUrl) {
    throw new TriggerError(400, 'This project has no custom target URL configured — set one on its Test Environment first')
  }

  const correlationId = crypto.randomUUID()

  // target_title reused to stash the target this run was generated against
  // — see authSetupStatus.js's staleness check.
  const { rows } = await db.query(
    `INSERT INTO generation_runs (project_id, suite_id, correlation_id, status, kind, target_title, created_by)
     VALUES ($1,NULL,$2,'pending','auth_setup',$3,$4) RETURNING *`,
    [projectId, correlationId, targetUrl, userId]
  )
  await recordDispatch(correlationId, tenantId, 'generation_run')

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_AUTH_SETUP_WORKFLOW_ID}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'master',
        inputs: { correlation_id: correlationId },
      }),
    }
  )

  if (!ghRes.ok) {
    const errText = (await ghRes.text()).slice(0, 500)
    await db.query(
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
export async function reconcileStaleRuns(db, projectId) {
  const { rows } = await db.query(
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
export async function reconcileStaleGenerationRuns(db, projectId) {
  const { rows } = await db.query(
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