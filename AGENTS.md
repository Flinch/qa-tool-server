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
- If a test fails because BEHAVIOR changed (the Expect no longer matches what
  the app does), do NOT rewrite the assertion to match the new behavior. Mark
  it `test.fixme()` with a `// POSSIBLE REGRESSION:` comment describing
  expected vs actual — a flagged real bug is more valuable than a green test.
- Apply the minimal fix. Never refactor passing tests during a heal.
