import { defineConfig } from '@playwright/test'
import base from './playwright.config'

/**
 * The dashboard load-time measurement (`tests/perf/`), run by hand with
 * `npm run test:perf` — before and after a performance change, to compare.
 * It is not part of `test:e2e` or CI: it measures, it does not assert a
 * budget. Same production build, server and seeded database as E2E; only the
 * test directory differs (the E2E config's `testDir` never reached it).
 */
export default defineConfig({
  ...base,
  testDir: './tests/perf',
  reporter: 'list',
})
