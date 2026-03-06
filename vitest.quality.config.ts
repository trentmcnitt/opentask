import { defineConfig } from 'vitest/config'
import fs from 'fs'
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

/**
 * Read provider env vars from a dotenv-style file.
 *
 * Vitest strips API key env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) from
 * the process environment before the config loads — this is a known vitest behavior.
 * To work around it, quality tests read API keys directly from a credentials file
 * when provider-specific env vars are needed.
 *
 * The QUALITY_ENV_FILE env var points to the credentials file (default: ~/.creds/api-keys.env).
 * Set provider config via OPENTASK_AI_* env vars which vitest does NOT strip.
 */
function loadCredsEnv(): Record<string, string> {
  const filePath =
    process.env.QUALITY_ENV_FILE || path.join(process.env.HOME || '', '.creds', 'api-keys.env')
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const vars: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      vars[key] = val
    }
    return vars
  } catch {
    return {}
  }
}

const creds = loadCredsEnv()

/**
 * Determine the test provider mode.
 *
 * Only inject API keys when explicitly running in API mode (OPENTASK_AI_PROVIDER
 * set to 'anthropic' or 'openai'). In SDK mode (the default), the Claude CLI
 * subprocess uses the user's Claude Code subscription — injecting an API key
 * would cause the CLI to use the Anthropic API directly instead, which fails
 * if the key has no credits.
 */
const testProvider = process.env.OPENTASK_AI_PROVIDER || 'sdk'
const isApiMode = testProvider === 'anthropic' || testProvider === 'openai'

/**
 * Resolve the API key for the OpenAI-compatible provider.
 *
 * When OPENAI_BASE_URL points to a non-OpenAI endpoint (xAI, OpenRouter),
 * the correct API key is selected automatically from the credentials file.
 */
function resolveOpenAIKey(): string | undefined {
  const baseUrl = process.env.OPENAI_BASE_URL || ''
  if (baseUrl.includes('x.ai')) return creds.XAI_API_KEY
  if (baseUrl.includes('openrouter')) return creds.OPENROUTER_API_KEY
  return creds.OPENAI_API_KEY
}

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
      // API keys — only inject in API mode. In SDK mode, the Claude CLI uses
      // its own auth; injecting a depleted API key causes the CLI to fail.
      ...(isApiMode && creds.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: creds.ANTHROPIC_API_KEY }),
      ...(isApiMode && resolveOpenAIKey() && { OPENAI_API_KEY: resolveOpenAIKey()! }),
      // Provider config from shell env (OPENTASK_AI_* vars are NOT stripped)
      ...(process.env.OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }),
      ...(process.env.OPENAI_MODEL && { OPENAI_MODEL: process.env.OPENAI_MODEL }),
      ...(process.env.OPENTASK_AI_PROVIDER && {
        OPENTASK_AI_PROVIDER: process.env.OPENTASK_AI_PROVIDER,
      }),
      ...(process.env.OPENTASK_AI_OPENAI_STRICT && {
        OPENTASK_AI_OPENAI_STRICT: process.env.OPENTASK_AI_OPENAI_STRICT,
      }),
      ...(process.env.OPENTASK_AI_ENRICHMENT_MODEL && {
        OPENTASK_AI_ENRICHMENT_MODEL: process.env.OPENTASK_AI_ENRICHMENT_MODEL,
      }),
      ...(process.env.OPENTASK_AI_QUICKTAKE_MODEL && {
        OPENTASK_AI_QUICKTAKE_MODEL: process.env.OPENTASK_AI_QUICKTAKE_MODEL,
      }),
      ...(process.env.OPENTASK_AI_WHATS_NEXT_MODEL && {
        OPENTASK_AI_WHATS_NEXT_MODEL: process.env.OPENTASK_AI_WHATS_NEXT_MODEL,
      }),
      ...(process.env.OPENTASK_AI_INSIGHTS_MODEL && {
        OPENTASK_AI_INSIGHTS_MODEL: process.env.OPENTASK_AI_INSIGHTS_MODEL,
      }),
      // Pass through OPENTASK_AI_CLI_PATH if explicitly set by the user
      ...(process.env.OPENTASK_AI_CLI_PATH && {
        OPENTASK_AI_CLI_PATH: process.env.OPENTASK_AI_CLI_PATH,
      }),
      // Clear NODE_OPTIONS — debugger bootloaders (VS Code, etc.) inherited via
      // this var cause Claude CLI subprocesses to crash with exit code 1.
      NODE_OPTIONS: '',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
