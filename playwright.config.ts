import { defineConfig, devices } from '@playwright/test'

/**
 * E2E runs against a PRODUCTION build (`next build` + `next start`), not the
 * dev server (2026-09-25). The dev server compiled each route on its first
 * visit, which on a 2-core CI runner made the first spec to reach a page pay
 * for the compile inside its own assertions' timeouts — the source of several
 * "flaky" first visits (the quota-prompts /settings test among them) and of
 * most of the job's ~17 minutes. A production build also tests what ships.
 *
 * `E2E_PREBUILT=1` skips the build and serves the `.next` already on disk —
 * for repeat local runs of an unchanged tree. Nothing sets it by default, so
 * an ordinary run can never test a stale build.
 */
const build = process.env.E2E_PREBUILT === '1' ? '' : 'npm run build && '

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry in CI, only so a failure leaves a trace behind
  // (`trace: 'on-first-retry'`). A test that passes on its retry is still a
  // failure there: `failOnFlakyTests` fails the run, so a flake shows up in
  // the summary instead of hiding behind a green check.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Run sequentially: every spec shares one database and one test user.
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
    command: `${build}npx next start -p 3333`,
    url: 'http://localhost:3333',
    // Always start fresh: globalSetup recreates the database, so a reused
    // server would still hold the old (deleted) DB connection via its singleton.
    reuseExistingServer: false,
    // Covers the build as well as the start.
    timeout: 300 * 1000,
    env: {
      OPENTASK_DB_PATH: 'data/test-e2e.db',
      OPENTASK_TEST_MODE: '1',
      AUTH_SECRET: 'test-secret-for-e2e-tests',
    },
  },
})
