import { defineConfig, devices } from '@playwright/test'

const STORAGE_STATE = process.env.STORAGE_STATE || '.auth/user.json'

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
  },
  projects: [
    // Logs in once and saves storageState for the `generated` project.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
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
