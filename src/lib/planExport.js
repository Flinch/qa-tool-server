// ============================================================================
// Plan exporter: test_cases rows -> planner-format Markdown
// ============================================================================
//
// This module is the CONTRACT between the qa-tool's data model and the
// Playwright agents. The generation workflow fetches its payload from
// GET /api/webhooks/generation-payload/:correlationId, writes each plan to
// specs/<filename> in the repo, and the planner agent verifies/refines those
// plans against the live app before the generator turns them into specs.
//
// Format rules (must stay in sync with AGENTS.md and the planner):
//  - One file per test case: specs/tc-<id>-<slug>.md
//  - "TC-<id>:" appears in the scenario heading — the generator copies the
//    scenario title into test() titles, which is how report-results.js later
//    links automated results back to this manual TC. Break this prefix and
//    the whole traceability chain breaks with it.
//  - Steps are a plain numbered list of actions (steps JSONB is an array of
//    strings with no numbering — numbering is added here).
//  - The expected outcome goes under "Expect:" — the generator's assertion
//    policy (AGENTS.md) requires every test to assert THIS, so a TC with a
//    vague `expected` produces a weak test. Garbage in, garbage out; that's a
//    data-quality problem to fix on the TC, not in this exporter.

import crypto from 'crypto'

// Identifies exactly the inputs buildPlanMarkdown turns into a skeleton plan.
// Used both to look up a cached verified plan (a hash match means nothing
// about this TC has changed since it was last live-verified, so the cached
// markdown is still trustworthy) and to write one back (see
// POST /webhooks/verified-plans) — recomputed server-side there rather than
// trusted from the CI payload, so a stale or forged hash can't poison the
// cache.
export function planSourceHash(tc) {
  const steps = Array.isArray(tc.steps) ? tc.steps.filter(s => String(s).trim()) : []
  return crypto.createHash('sha256')
    .update(JSON.stringify({ title: tc.title, steps, expected: tc.expected || '' }))
    .digest('hex')
}

// URL/filename-safe slug from a TC title: lowercase, alphanumerics and
// hyphens only, collapsed and trimmed, capped so filenames stay sane.
export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, '')     // no leading/trailing hyphens
    .slice(0, 60)                // keep paths readable in PRs and terminals
    .replace(/-+$/g, '')         // re-trim in case the cut landed on a hyphen
    || 'untitled'
}

export function planFilename(tc) {
  return `tc-${tc.id}-${slugify(tc.title)}.md`
}

// One test case -> one plan document. Kept deliberately close to the shape
// the planner agent itself produces (scenario heading, steps, expectations)
// so verifying OUR plans feels identical to it as refining its own.
//
// `platform`+`engine` pick the starting-state line: web+UI plans assume the
// `generated` Playwright project's authenticated storageState; mobile has
// no equivalent concept, just a freshly-launched app; `engine === 'api'`
// (API testing, Phase 1) has neither a browser nor a page at all — the
// api-test-planner/-generator agents work against the `request` fixture
// directly, so the framing says that explicitly rather than implying a
// browser session exists.
export function buildPlanMarkdown(tc, platform = 'web', engine = null) {
  const steps = Array.isArray(tc.steps) ? tc.steps.filter(s => String(s).trim()) : []

  const lines = []
  lines.push(`# TC-${tc.id}: ${tc.title}`)
  lines.push('')
  // Machine-readable breadcrumbs for humans reading the PR and for the
  // planner (the type hints how deep the flow goes). HTML comments render
  // invisibly on GitHub, so the PR view stays clean.
  lines.push(`<!-- source: qa-tool test case ${tc.id} | type: ${tc.type} -->`)
  if (tc.automation_reasoning) {
    lines.push(`<!-- automation rationale: ${tc.automation_reasoning} -->`)
  }
  lines.push('')
  lines.push(`## Scenario: TC-${tc.id} — ${tc.title}`)
  lines.push('')
  lines.push(engine === 'api'
    ? 'Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL.'
    : platform === 'web'
    ? 'Starting state: authenticated (storageState), on the dashboard.'
    : 'Starting state: app freshly launched.')
  lines.push('')
  lines.push('Steps:')
  if (steps.length === 0) {
    // A candidate TC with no steps can't be grounded. Surface it in the plan
    // itself (the planner will flag it, the PR reviewer will see it) rather
    // than silently emitting an empty list.
    lines.push('1. (no steps recorded on this test case — planner: flag as blocked)')
  } else {
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`))
  }
  lines.push('')
  lines.push(`Expect: ${tc.expected?.trim() || '(no expected result recorded — planner: flag as blocked)'}`)
  lines.push('')
  return lines.join('\n')
}

// Fetch + convert in one call — this is what the generation-payload endpoint
// uses. Returns rows in the caller-requested order-independent form:
// [{ tc_id, filename, markdown }]
//
// Re-validates eligibility at export time, same condition automationTrigger.js
// checks at dispatch time (api-engine suite -> type='api' TCs; everything
// else -> automation_candidate=true TCs) — keep these two in sync. Belt and
// suspenders on purpose: a TC could have been edited or un-flagged in the
// minutes between clicking Generate and CI fetching the payload, and
// exporting a stale/ineligible TC would waste an expensive agent run on it.
// This is exactly where TC 72 (type='api', automation_candidate=false, a
// perfectly valid API test) silently vanished on 2026-08-05 — this query
// still only checked automation_candidate=true after the dispatch-time
// check had already been widened to also accept type='api', so dispatch
// succeeded but the payload came back with zero plans.
export async function exportPlansForTestCases(db, projectId, testCaseIds, platform = 'web', engine = null) {
  if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) return []

  const isApiSuite = engine === 'api'
  const { rows } = await db.query(
    `SELECT id, title, type, steps, expected, automation_reasoning
     FROM test_cases
     WHERE project_id = $1 AND id = ANY($2::int[])
       AND (
         ($3::boolean AND type = 'api')
         OR (NOT $3::boolean AND automation_candidate = true AND type != 'api')
       )
     ORDER BY id`,
    [projectId, testCaseIds, isApiSuite]
  )
  if (rows.length === 0) return []

  // A cached plan is only reused when its stored hash still matches this
  // TC's CURRENT title/steps/expected — if the TC changed since it was last
  // verified, that's a silent cache miss (not an error), and this just falls
  // back to a fresh skeleton like before this cache existed.
  const { rows: cached } = await db.query(
    `SELECT test_case_id, source_hash, markdown FROM test_case_verified_plans WHERE test_case_id = ANY($1::int[])`,
    [rows.map(tc => tc.id)]
  )
  const cacheByTcId = new Map(cached.map(c => [c.test_case_id, c]))

  return rows.map(tc => {
    const hit = cacheByTcId.get(tc.id)
    const verified = hit?.source_hash === planSourceHash(tc)
    return {
      tc_id: tc.id,
      filename: planFilename(tc),
      markdown: verified ? hit.markdown : buildPlanMarkdown(tc, platform, engine),
      // Tells generate-tests.js this plan is already live-verified and
      // doesn't need the planner's full re-derivation — see its
      // "verified"-aware prompt branch and the cache-skip path when every
      // plan in the batch is already a hit.
      verified,
    }
  })
}