import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Quality test configuration — separate from behavioral/integration tests.
 *
 * Quality tests run each scenario through the real AI (requires OPENTASK_AI_ENABLED=true
 * and the Claude CLI). They run sequentially with long timeouts because each scenario
 * spawns an AI subprocess.
 *
 * Run with: npm run test:quality
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/quality/**/*.test.ts'],
    // Sequential — each test spawns an AI subprocess
    fileParallelism: false,
    // Long timeout per scenario (AI subprocess can take time)
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters: ['default'],
    // Use a dedicated database for quality tests so aiQuery's activity
    // logging doesn't depend on the dev database existing
    env: {
      OPENTASK_DB_PATH: path.resolve(__dirname, 'data', 'test-quality.db'),
      OPENTASK_AI_ENABLED: 'true',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
