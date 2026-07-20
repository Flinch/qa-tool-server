# AGENTS.md — Test Generation Conventions for this Repo

You are generating and healing Playwright tests for the Service Desk app
(baseURL in playwright.config.js, override with TARGET_URL). Generated code is
reviewed by a human in a pull request. Optimize for correctness, readability,
and assertion quality — not volume.

## Where things live

- Generated specs: `tests/generated/<suite-slug>/tc-<ids>-<slug>.spec.ts`
- Test plans: `specs/tc-<id>-<slug>.md`
- Shared helpers: `helpers/` (auth.ts, createTicket.ts, testData.ts)
- Generated tests run under the `generated` Playwright project, which starts
  AUTHENTICATED via storageState (see tests/auth.setup.ts and tests/seed.spec.ts).
  NEVER write login steps inside a generated test. The only exception is a test
  whose subject IS authentication — those belong in tests/smoke, not generated.

## Traceability (required)

- Every `test()` title starts with its manual test case id: `test('TC-42: ...')`.
- Wrap each numbered plan step in `test.step('<step text>', ...)`.
- One spec file per plan file. Keep the plan's scenario titles.

## Locator policy (strict priority order)

1. `getByRole(role, { name })`
2. `getByLabel` / `getByPlaceholder`
3. `getByTestId`
4. `getByText` — only for static, unique text
5. CSS — last resort, must carry a `// FRAGILE:` comment

Never: auto-generated class names, positional `.nth()` on comboboxes/rows,
chained nth-child, XPath. If the only way to reach an element is positional,
add the FRAGILE comment and note it for the reviewer.

## Assertion policy

Every test must assert the BUSINESS OUTCOME from its plan's `Expect:` lines,
not incidental UI state.

- Bad:  `expect(submitButton).toBeVisible()` as the final assertion
- Good: `expect(page.getByRole('row', { name: data.title })).toContainText('Open')`

If the expected outcome cannot be verified through the UI, say so in a comment
and mark the test `test.fixme()` — do not substitute a weaker assertion.

## Behavior mismatch policy (applies at every stage — planning, generation, healing)

If live verification shows the app's ACTUAL behavior contradicts a plan's
`Expect:` outcome — not a wording or locator problem, a genuine functional
contradiction (e.g. the plan says an action should be rejected, but the app
allows it, or vice versa) — do not try to force a plan or test to match the
wrong/missing behavior, and do not wait indefinitely for a state that will
not occur. A flagged real bug is more valuable than a green test, whichever
stage catches it.

- **Planner**: stop verifying that scenario, note the contradiction directly
  in the plan file (`<!-- BEHAVIOR MISMATCH: expected ..., actual ... -->`),
  and move on to the next plan in the batch rather than retrying or waiting
  for the expected state to appear.
- **Generator**: if a plan carries a BEHAVIOR MISMATCH marker, or the
  contradiction only becomes apparent while implementing, still write the
  file — mark the test `test.fixme()` with a `// POSSIBLE REGRESSION:`
  comment describing expected vs actual (same convention the healer uses
  below). Do not substitute a weaker assertion, and do not skip writing the
  file entirely — a fixme'd test that documents the mismatch is the correct,
  reviewable outcome here, not a missing one.
- **Healer**: see Healing rules below — same policy, later stage.

## Test data policy

- Tests create the data they need and must pass twice in a row.
- Unique values via `createTestData()` in helpers/testData.ts (extend it if a
  flow needs new fields) — never hardcoded titles, emails, or usernames.
- Reuse `createTicket(page)` from helpers/createTicket.ts for ticket setup
  instead of re-implementing the modal flow.
- If a test mutates data it did not create, don't write it — flag it for the
  reviewer instead.

## Stability rules

- No `page.waitForTimeout()`. Use web-first assertions and locator auto-waiting.
- Toasts in this app auto-dismiss: assert on them immediately after the action.
- Each test is independent: no ordering dependencies between tests in a file.

## Healing rules

- Fix locators and timing freely, confirmed by re-running against the live app.
- If a test fails because BEHAVIOR changed, follow the Behavior mismatch
  policy above: `test.fixme()` with a `// POSSIBLE REGRESSION:` comment, never
  a rewritten assertion.
- Apply the minimal fix. Never refactor passing tests during a heal.

## Mobile tests (Maestro)

Everything above this section is the web (Playwright) pipeline. Native
mobile tests are a separate pipeline using
[maestro-test-planner](.claude/agents/maestro-test-planner.md),
[maestro-test-generator](.claude/agents/maestro-test-generator.md), and
[maestro-test-healer](.claude/agents/maestro-test-healer.md) against the
`maestro` MCP server (registered in `.mcp.json`) instead of `playwright-test`.
Full detail and the real evidence behind the rules below is in
`mobile-spike/FINDINGS.md`.

- Generated flows: `tests/generated-mobile/<platform>/<suite-slug>/<scenario-name>.yaml`
- Test plans: `specs/mobile-<suite-slug>.md`
- Every selector — tap, type, or assert — must be confirmed against a real
  `inspect_screen` call before it's used, never authored from a screenshot or
  from what "should" be there. Two real, reproduced failure modes make this
  non-negotiable: hidden/extra text (Maestro's raw hierarchy can carry text
  not visible on screen) and full-string regex matching (`text: "4"` will
  not match real text `"4 Calculation result"` — needs `text: "4.*"`).
- Prefer `id:`-scoped selectors (real `resource-id` from `inspect_screen`)
  over bare `text:` assertions whenever there's any chance of the same text
  appearing elsewhere on screen (numeric keypads, counters, repeated
  labels). An unscoped `assertVisible: "4"` will false-positive against a
  permanently-visible "4" digit key even if the actual result never updated
  — this was reproduced, not hypothetical, in the Phase 0 spike.
- Behavior mismatch policy is the same idea as the web pipeline's, adapted
  to YAML (no `test.fixme()` equivalent exists): add a `# POSSIBLE
  REGRESSION: <expected vs. actual>` comment above the mismatched step, and
  add `tags: [flagged-regression]` to the flow's frontmatter so it's
  committed and reviewable but excluded from normal runs.
- No AI-generated code should exist outside `tests/generated-mobile/` —
  hand-written mobile flows (if any) get their own top-level folder, same
  separation the web pipeline already keeps between `tests/<slug>/` and
  `tests/generated/<slug>/`.
