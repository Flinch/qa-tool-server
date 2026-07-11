import { query } from '../db/pool.js'

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
export function buildPlanMarkdown(tc) {
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
  // Matches the seed spec: the `generated` Playwright project starts
  // authenticated via storageState, so plans assume a logged-in start.
  lines.push('Starting state: authenticated (storageState), on the dashboard.')
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
// Re-validates automation_candidate at export time, same as the trigger did
// at dispatch time. Belt and suspenders on purpose: a TC could have been
// edited or un-flagged in the minutes between clicking Generate and CI
// fetching the payload, and exporting a stale/ineligible TC would waste an
// expensive agent run on it.
export async function exportPlansForTestCases(projectId, testCaseIds) {
  if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) return []

  const { rows } = await query(
    `SELECT id, title, type, steps, expected, automation_reasoning
     FROM test_cases
     WHERE project_id = $1 AND id = ANY($2::int[]) AND automation_candidate = true
     ORDER BY id`,
    [projectId, testCaseIds]
  )

  return rows.map(tc => ({
    tc_id: tc.id,
    filename: planFilename(tc),
    markdown: buildPlanMarkdown(tc),
  }))
}