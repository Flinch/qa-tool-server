import { defineConfig, devices } from '@playwright/test'

const STORAGE_STATE = process.env.STORAGE_STATE || '.auth/user.json'

// Which login flow the 'setup' project below actually runs. Multiple
// projects' per-project auth-setup files (tests/auth-setups/*.setup.ts) all
// live in this same checkout at once, so testMatch must be scoped to the ONE
// file this job's target env resolved to (see lib/testEnvironment.js's
// authSetupFile) — matching all of them with a wildcard would run every
// project's login flow, against every other project's wrong target, in the
// same job. Falls back to the original shared file when a project has no
// custom target configured (AUTH_SETUP_FILE unset), so the demo project's
// existing setup keeps working with zero changes to its CI wiring.
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const setupTestMatch = process.env.AUTH_SETUP_FILE
  ? new RegExp(escapeForRegex(process.env.AUTH_SETUP_FILE) + '$')
  : /auth\.setup\.ts$/

// Specs that switch identities mid-test (log out and log back in as a
// different user — see helpers/project-7/loginAs.ts) must NOT inherit the
// single `.auth/user.json` session every other 'generated' spec starts
// from. OrangeHRM's logout is a server-side session destroy, not a
// client-local action, so when one of these runs in parallel with anything
// else still holding that same inherited cookie (workers: 2 in CI), the
// logout kills the OTHER test's session too, mid-test. Confirmed live: with
// TC-64 sharing the 'generated' project's storageState, every suite run
// kicked TC-63 and TC-65 to the login page mid-test (whichever two happened
// to be running in the other worker at the time), while all three passed
// individually — the exact same run just without the parallel collision.
// Add any future spec that calls loginAs() here.
const SELF_AUTH_SPECS = /tc-64-employee-submits-a-leave-request-and-authorised-approver-app\.spec\.ts$/

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['json', { outputFile: 'results.json' }],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: process.env.TARGET_URL || 'https://service-desk-roan.vercel.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // 'on' (not 'retain-on-failure') deliberately — the ask is to be able
    // to watch the actual playback even for a PASSING test, to confirm it
    // really went through the intended flow rather than just trusting the
    // step list. Embeds automatically into the existing HTML report
    // already linked from the frontend's "Report" button
    // (AutomationPage.jsx/ExecutionRunDetailPage.jsx), no other changes
    // needed.
    video: 'on',
    // Playwright's default is NO action timeout — a click/fill/etc. that
    // never becomes actionable (element present but never satisfies
    // visible+stable+enabled+receives-events) waits forever. Confirmed
    // live: this is exactly what happened on OrangeHRM's "Create Login
    // Details" toggle, where the real accessible name doesn't match its
    // visible label, causing the generation agent's click to hang for the
    // entire 15-minute agent timeout instead of failing fast. This applies
    // to every Playwright-API-driven action — the run-test-mcp-server
    // agent tool calls (planner/generator/healer) AND real test execution
    // runs alike, since both go through this same config. A failed action
    // now surfaces as a catchable error within the agent's own turn,
    // giving it a chance to try a different locator instead of losing the
    // whole run to one stuck click.
    actionTimeout: 30_000,
  },
  projects: [
    // Logs in once and saves storageState for the `generated` project.
    {
      name: 'setup',
      testMatch: setupTestMatch,
      use: { ...devices['Desktop Chrome'] },
    },
    // Existing hand-written suites (smoke/regression/e2e/integration).
    // Unchanged behavior: they start logged OUT and handle login themselves.
    {
      name: 'chromium',
      testMatch: /tests\/(smoke|regression|e2e|integration)\/.*\.spec\.(js|ts)$/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Agent-generated tests + the seed spec: start AUTHENTICATED.
    {
      name: 'generated',
      testMatch: [/tests\/generated\/.*\.spec\.(js|ts)$/, /tests\/seed\.spec\.ts$/],
      testIgnore: SELF_AUTH_SPECS,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
    },
    // Identity-switching specs (see SELF_AUTH_SPECS above): start with a
    // genuinely blank, unauthenticated context — no storageState — and log
    // themselves in as their own first step instead (loginAs.ts skips its
    // logout click when there's no session to log out of). Never shares a
    // session with any other project, so its mid-test logout can't affect
    // anyone else, however many workers run in parallel. `dependencies:
    // ['setup']` is kept for ORDERING ONLY, not storageState (deliberately
    // not set below) — confirmed live this still matters even without a
    // shared session: with no dependency at all, this project's own login
    // ran fully in parallel with 'setup' logging in as qatooladmin, and the
    // two concurrent logins against the single self-hosted instance
    // collided (setup's login got rejected/redirected back to itself).
    // Running strictly after 'setup' completes avoids that without
    // reintroducing the shared-session problem this project exists to fix.
    {
      name: 'generated-self-auth',
      testMatch: SELF_AUTH_SPECS,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
