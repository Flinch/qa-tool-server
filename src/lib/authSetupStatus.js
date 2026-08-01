// Computes whether a project's auth-setup (per-project login flow, see
// tests/auth-setups/) is generated and merged, live off generation_runs +
// a real-time GitHub PR check — not a persisted status column, so it can
// never go stale and needs no PR-merge webhook receiver (this app doesn't
// have one; GET /generation-runs already solves the identical "is this PR
// merged" question the same way, via getPrStatus).
import { getPrStatus } from './githubPrStatus.js'

export async function getAuthSetupStatus(db, projectId) {
  const { rows: configRows } = await db.query(
    `SELECT target_url FROM project_test_config WHERE project_id=$1`,
    [projectId]
  )
  const targetUrl = configRows[0]?.target_url
  // No custom target configured — project uses the shared demo fallback,
  // which already has a working, checked-in auth.setup.ts. No gate.
  if (!targetUrl) return { needed: false }

  const { rows: runRows } = await db.query(
    `SELECT * FROM generation_runs
     WHERE project_id=$1 AND kind='auth_setup'
     ORDER BY started_at DESC LIMIT 1`,
    [projectId]
  )
  const run = runRows[0]

  // No run yet, or the latest run targeted a different URL than the one
  // configured now (target_title stashes what it was generated against) —
  // either way, nothing valid exists for the CURRENT target.
  if (!run || run.target_title !== targetUrl) {
    return { needed: true, status: 'not_generated' }
  }

  if (run.status === 'failed') {
    return { needed: true, status: 'failed', run }
  }
  if (!['completed'].includes(run.status)) {
    return { needed: true, status: 'in_progress', run }
  }
  if (!run.pr_url) {
    // Completed with no PR link is unexpected (the workflow always opens
    // a PR before reporting completion) — treat like nothing usable exists
    // yet rather than silently treating it as verified.
    return { needed: true, status: 'not_generated' }
  }

  const prStatus = await getPrStatus(run.pr_url)
  return prStatus.merged
    ? { needed: true, status: 'verified', run }
    : { needed: true, status: 'pending_review', run, pr_url: run.pr_url }
}

export async function isAuthSetupBlocking(db, projectId) {
  const result = await getAuthSetupStatus(db, projectId)
  return result.needed && result.status !== 'verified'
}
