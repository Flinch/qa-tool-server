# Phase 0 — Apply Notes

## New files
- AGENTS.md                          agent conventions (the leverage file — iterate here)
- tests/auth.setup.ts                logs in once, saves .auth/user.json
- tests/seed.spec.ts                 authenticated seed the agents template from
- tests/generated/                   destination for generated specs
- .auth/.gitignore                   keeps storage state out of git
- specs/tc-example-ticket-creation.md  plan format reference (Phase 1 exporter emits this shape)
- .claude/agents/*.md, .mcp.json, specs/README.md   official init-agents scaffold (playwright 1.61)

## Modified files
- playwright.config.js   three projects: setup / chromium (existing suites,
                         unchanged behavior) / generated (authenticated,
                         depends on setup). baseURL + storageState now
                         env-overridable (TARGET_URL, STORAGE_STATE).
- helpers/auth.ts        creds from TEST_USER_NAME / TEST_USER_PASSWORD /
                         TEST_USER_DISPLAY_NAME env vars, demo fallbacks kept
                         so nothing breaks locally.

Existing specs (smoke/regression/e2e/integration) were NOT touched — they
still log in inline and run under the chromium project exactly as before.
Optional cleanup later: swap their inline logins for loginAsAdmin(page).

## Add to .gitignore (repo root)
.auth/
results.json
playwright-report/

## Env (local shell or .env used by Playwright, and later CI secrets)
TEST_USER_NAME=Carol
TEST_USER_PASSWORD=admin
TEST_USER_DISPLAY_NAME=Carol Kim
# TARGET_URL=https://service-desk-roan.vercel.app   (optional override)

## Verify locally (in order)
1. npm i && npx playwright install chromium
2. npx playwright test tests/seed.spec.ts
   -> runs setup (login + storageState) then the authenticated seed. If the
      seed fails while setup passes, the app likely doesn't restore auth from
      storage — tell Claude and we'll switch strategies.
3. npx playwright test tests/smoke   -> old suites still green, still logged-out flow.

## Agent dry run (in Claude Code, repo root)
1. "Use the playwright-test-planner agent to verify and refine the plan in
   specs/tc-example-ticket-creation.md against the running app, following
   AGENTS.md. Amend step wording to match the real UI; do not invent new scenarios."
2. Review/edit the amended plan.
3. "Use the playwright-test-generator agent to implement the plan as
   tests/generated/demo/tc-example-ticket-creation.spec.ts per AGENTS.md."
4. npx playwright test tests/generated/demo  (should pass twice in a row)
5. Break a locator on purpose, then: "Use the playwright-test-healer agent to
   fix the failing test in tests/generated/demo."

Exit criteria: generated spec passes twice consecutively; healer repairs the
broken locator; you like the code style. Then we start Phase 1 (generation_runs
table + plan exporter + endpoints).
