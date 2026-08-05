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

- **Planner**: the WEB planner is browserless (see Agent cost discipline
  below) and cannot observe live behavior — its mismatch duty is limited to
  what's visible from the documents alone: a plan whose steps contradict
  its own Expect line, or a "flag as blocked" marker from planExport. Flag
  those with a comment in the plan file; live contradictions are discovered
  at generation/healing instead. The API planner still live-verifies with
  `curl` and follows the original rule: stop verifying that scenario, note
  the contradiction directly in the plan file
  (`<!-- BEHAVIOR MISMATCH: expected ..., actual ... -->`), and move on to
  the next plan rather than retrying or waiting for the expected state.
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

## Agent cost discipline

Every generation/heal run bills real time and tokens against a hard cost
cap — a run that burns its budget on redundant browsing produces NOTHING.
These rules come from a real run that nearly hit the cap:

- **Setup-page invocation**: `generator_setup_page` in this repo requires
  `{seedFile: 'tests/seed.spec.ts', project: 'generated'}`. A bare call
  fails with "seed test not found" — don't rediscover this by trial and
  error; use the working invocation on the first try. (The WEB planner has
  no browser at all — no setup-page tool applies to it.)
- **Snapshot sparingly**: a full `browser_snapshot` is ~55KB of context per
  call. Most action results already describe the resulting page — snapshot
  only when you need element refs for the NEXT interaction and the last
  result didn't include them. Never snapshot as a reflex after every
  action.
  **Exception — always recapture immediately after a navigation/URL change,
  or after any "ref not found" / "does not match any elements" tool error.**
  A ref from before the page changed is guaranteed stale; retrying it is not
  cheaper than a fresh snapshot, it's a guaranteed failure that still costs a
  turn. Confirmed live: a real generation run spent its entire 15-minute
  budget retrying a stale ref after a sidebar navigation instead of
  recapturing once, and was killed having produced nothing.
- **One live walkthrough per run.** The WEB planner is browserless (repo
  review only); the generator's single walkthrough is the ONLY live
  browsing in the run, and it doubles as verification while capturing
  locators. There is no inline heal loop after it — generation ends with a
  single non-agent Playwright run to check and report pass/fail, nothing
  more; healing (if the generated test needs it) is a separate, explicit
  run against heal-test(-orangehrm).yml, not an automatic part of
  generation. (Removed after a real run got killed mid-heal-loop by the
  agent timeout, burning its whole remaining budget on a step that wasn't
  even a guarantee — see generate-tests.js's comment above the Playwright
  check for the full story.) Nobody re-walks a flow live to double-check
  work they just completed successfully.
- **Update plan files with Edit, in place** — `planner_save_plan`
  regenerates an existing plan in the wrong format (drops traceability
  comments and the Steps/Expect shape), forcing an expensive restore pass.
- **Shared demo targets drift**: public demo apps (e.g. OrangeHRM's) are
  mutated by strangers mid-run — the UI language itself once changed to
  Spanish partway through a real run. If the app suddenly looks wrong,
  suspect external interference first; fix the setting once if it blocks
  you (as briefly as possible) rather than re-diagnosing your own steps.

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

### Known app quirks (real findings — check here before re-diagnosing from scratch)

- **iOS keyboard won't dismiss via `hideKeyboard` or a tapped Return/Done
  key.** Reproduced live on the Sauce Demo iOS app: `hideKeyboard` fails
  outright ("Couldn't hide the keyboard..."), and tapping a visible
  `id: "Return"` key reports `success: true` but does NOT actually dismiss
  the keyboard or submit the field — a false-positive-success trap, not a
  real fix. **Known-working alternative**: navigate away from the current
  screen (tap the real back/close control) and back into it — the keyboard
  clears and the already-entered text is retained. Use this directly instead
  of retrying `hideKeyboard`/Return variants.

## API tests (Playwright `request` fixture)

Everything above the Mobile section is the browser/UI pipeline. API tests
are a third pipeline: same Playwright install, same `tests/generated/`
convention, but no browser at all — using
[api-test-planner](.claude/agents/api-test-planner.md),
[api-test-generator](.claude/agents/api-test-generator.md), and
[api-test-healer](.claude/agents/api-test-healer.md), which verify against
the live API with `curl` over Bash instead of driving a browser.
Applies to any suite with `engine: 'api'` (see automation_suites in the QA
tool's schema) — `generate-tests.js` picks this trio instead of the web
trio based on the generation payload's `engine` field.

- Generated specs: `tests/generated/<suite-slug>/tc-<ids>-<slug>.spec.ts`
  — same directory convention as web, so `playwright.yml`'s
  `tests/$SLUG tests/generated/$SLUG` run command needs no changes at all.
- Test plans: `specs/tc-<id>-<slug>.md` — same plan format as web (produced
  by `planExport.js`'s `buildPlanMarkdown`), except the "Starting state"
  line says explicitly there is no browser/page/storageState and gives the
  configured baseURL instead.
- Every generated test uses Playwright's `request` fixture —
  `test('TC-42: ...', async ({ request }) => { ... })` — never `page`,
  never `browser_*` tools. `request` inherits `use.baseURL` from
  `playwright.config.js` the same way `page` does (this app's API and
  frontend share an origin — see the QA tool's Phase 1 plan for why a
  separate `API_BASE_URL` isn't needed yet). `test`/`expect` come from
  `helpers/apiTrace` (a drop-in replacement for `@playwright/test`'s own
  exports), never `@playwright/test` directly — it transparently wraps
  `request` to capture every call made during a failing test and attach it
  for the UI, same idea as `screenshot: 'only-on-failure'` for web tests.

### Traceability (required)

Same rule as web: every `test()` title starts with its manual test case id
(`test('TC-42: ...')`), one spec file per plan file, keep the plan's
scenario title.

### Assertion policy

Assert the BUSINESS OUTCOME from the plan's `Expect:` line — status code
AND response body/schema, not just "request didn't throw."

- Bad:  `expect(response.ok()).toBeTruthy()` as the only assertion
- Good: `expect(response.status()).toBe(201); expect(body.status).toBe('open')`

Check the response body shape (the fields the plan's `Expect:` line actually
names), not just status code alone — a 200 with the wrong body is still a
failure.

### Auth policy

If the endpoint requires auth, obtain a token/session the same
programmatic way for every test (a shared helper, mirroring how
`helpers/auth.ts` centralizes storageState for the web pipeline — extend
`helpers/` with an API equivalent rather than re-implementing login-for-token
per spec file). Never hardcode a token value in a generated spec.

### Verification workflow (planner + generator)

There is no live browser to explore, so verification means real HTTP calls,
not UI navigation:

- **Planner**: refine each plan against the real API using `curl` over Bash
  — confirm the endpoint exists, confirm the actual status code
  and response shape for both the happy path and the plan's stated edge
  case, before finalizing the plan.
- **Generator**: implement the plan as a `request`-fixture spec. Prefer
  reusing an existing suite-level helper for setup data (creating a
  resource the test then acts on) over re-implementing it per spec, same
  "don't re-verify what's already proven" principle the web generator uses
  for its own helpers.
- **Behavior mismatch policy** (same idea as web's, see above): if live
  `curl` verification shows the API's actual status/response genuinely
  contradicts the plan's `Expect:` — not a wording issue, a real
  contradiction — don't force the assertion to match. Note it in the plan
  (planner) or mark `test.fixme()` with a `// POSSIBLE REGRESSION:` comment
  (generator/healer), exactly like the web pipeline.
- **One command per Bash call — never chain, never `cd`.** The sandbox
  checks the WHOLE command string against a single allowed prefix (e.g.
  `curl`, `grep`) — a compound command like `cd /tmp && rm -f x\ncurl ...`
  gets denied wholesale because it starts with `cd`, even though the
  `curl` later in the same string would be fine on its own. This isn't
  theoretical: it's exactly what killed a real generation run's entire
  planner batch on 2026-08-05 after the agent had already done the actual
  verification work — every accumulated denial fails the batch regardless
  of what real progress happened around it. Use an absolute path instead
  of `cd` (`curl -c /tmp/cookies.txt ...`, not `cd /tmp && curl -c
  cookies.txt ...`), and issue `curl`/`grep`/`cat`/`ls`/`wc`/`find`/`head`/
  `tail` as their own separate Bash calls, one command each — every one of
  those is individually allowed; a compound string mixing them is not.

### Stability rules

- No arbitrary waits/sleeps — Playwright's `request` calls are synchronous
  from the test's perspective, there's no loading state to wait out.
- Each test creates the data it needs and must pass twice in a row, same
  test data policy as web (unique values, never hardcoded ids/titles).
- Each test is independent — no ordering dependencies between tests in a
  file.

### Healing rules

- Run `npx playwright test <path>` directly (Bash) to see the real failure,
  then `curl` the same endpoint to compare actual vs. expected response
  before editing anything.
- Fix request payloads, headers, and assertions freely, confirmed by
  re-running against the live API.
- If a test fails because the API's actual behavior changed, follow the
  Behavior mismatch policy above: `test.fixme()` with a
  `// POSSIBLE REGRESSION:` comment, never a rewritten assertion.
- Apply the minimal fix. Never refactor passing tests during a heal.

## Auth setup generation (per-project login flows)

A single shared `tests/auth.setup.ts` can't serve every project — this repo
is multi-tenant, and different projects' apps have genuinely different login
forms. Projects with a custom target URL (see `project_test_config`) get
their own generated file instead: `tests/auth-setups/project-<id>.setup.ts`.
Projects with no custom target keep using the original shared
`tests/auth.setup.ts`/`helpers/auth.ts` untouched.

- **Self-contained**: a per-project file does not import from
  `helpers/auth.ts` — write the login steps directly in the file, since the
  flow is specific to that one project's app.
- **Real credentials, never hardcoded**: fill fields from
  `process.env.TEST_USER_NAME`/`TEST_USER_PASSWORD`, exactly like the
  original shared helper does.
- **Generic success assertion**: assert something true of ANY successful
  login (the password field/login form is gone, the URL left the login
  path) — never an app-specific hardcoded string like a display name or
  welcome text, since the agent generating this has no prior knowledge of
  the target app's post-login UI beyond what it just observed live.
- **Locator policy**: same strict priority order as the main Locator policy
  above (role + accessible name first).
- **Bounded verification loop**: after writing the file, actually run it
  (`npx playwright test --project=setup`, which picks up this specific file
  via `playwright.config.js`'s env-scoped `testMatch`). If it fails, revise
  and re-run — up to 3 attempts total. Stop after that with the best-effort
  version rather than looping indefinitely; the CI workflow's own objective
  verify step and the PR review are the real safety net, not an unbounded
  agent loop.

## Per-project reusable helpers

The web pipeline's `helpers/` folder (`auth.ts`, `createTicket.ts`,
`testData.ts`) is hand-written specifically for the original demo app and
stays exactly as-is. A project with its own custom target gets its own
parallel helpers directory instead: `helpers/project-<id>/`. This exists so
a project's *second* generation run (a different feature, a different
suite) doesn't have to rediscover the same login-adjacent navigation or
common setup steps the *first* run already proved out live — the same idea
as the per-project auth-setup file above, generalized to ordinary reusable
flows instead of just login.

- **Check before verifying live**: both the planner and generator check
  `helpers/project-<id>/` (via `Glob` + `Read`) for an existing helper that
  already covers a plan step before live-verifying it — same "don't
  re-verify what's already proven" principle the flat `helpers/` folder
  already gets for the demo project.
- **When the generator extracts one**: if a step needed live verification
  because no existing helper covered it, and that step is a genuinely
  reusable setup/entry action for this app (logging in and reaching a
  specific form, creating a core record, anything future test cases for
  this app will likely need again) — not a one-off or assertion-only step —
  write it into a new file under `helpers/project-<id>/` instead of only
  inlining it into the one spec.
- **Shape**: one exported `async function` taking `page` (plus optional
  data overrides), same pattern as `helpers/createTicket.ts` — a single
  clear responsibility, not a grab-bag. A one-line comment at the top
  describing what it does and when to reuse it, so a future run can decide
  relevance from the file list alone without executing anything.
- **Import convention**: `import { x } from '../../../helpers/project-<id>/y'`
  — identical relative-path shape the flat `helpers/*` imports already use
  from `tests/generated/<suite-slug>/*.spec.ts`.
- **Never duplicate**: always check what's already there first — reusing
  (or extending, if it's close but not quite right) an existing helper
  beats writing a near-duplicate.
- **Healer**: may use an existing helper while fixing a spec, but does not
  create new ones during a heal — same "apply the minimal fix, never
  refactor" boundary as the Healing rules above.
