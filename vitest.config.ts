import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/quality/**'],
    // Run test files sequentially to avoid database conflicts
    // Each test file resets the database, so parallel execution causes conflicts
    fileParallelism: false,
    reporters: ['default', 'github-actions', 'json'],
    outputFile: {
      json: 'test-results/behavioral.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/core/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
