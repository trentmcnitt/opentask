import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Run sequentially: tests share a single database and the webpack dev
  // server degrades under concurrent compilation, causing flaky timeouts.
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: 'http://localhost:3333',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Use --webpack to avoid Turbopack cache corruption: the shared .next
    // directory can become stale when the E2E server starts with different
    // env vars than normal dev, causing page compilation to hang.
    command: 'PORT=3333 npx next dev --webpack',
    url: 'http://localhost:3333',
    // Always start fresh: globalSetup recreates the database, so a reused
    // server would still hold the old (deleted) DB connection via its singleton.
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      OPENTASK_DB_PATH: 'data/test-e2e.db',
      OPENTASK_TEST_MODE: '1',
      AUTH_SECRET: 'test-secret-for-e2e-tests',
    },
  },
})
