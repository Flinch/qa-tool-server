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
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
    },
  ],
})
