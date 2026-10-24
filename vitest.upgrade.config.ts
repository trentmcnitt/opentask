import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * The upgrade test (tests/upgrade/): this change's code opened on databases an
 * older release made. Its own config and command (`npm run test:upgrade`),
 * not part of `npm test`: it reads the base release's schema.sql from git, so
 * it needs the history (CI's Upgrade job checks out with fetch-depth: 0).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/upgrade/**/*.test.ts'],
    fileParallelism: false,
    // Warnings and errors only: the default outside production is trace. The
    // test asserts nothing is logged at error level.
    env: { LOG_LEVEL: 'warn' },
    reporters: ['default', 'github-actions'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
