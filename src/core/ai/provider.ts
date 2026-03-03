/**
 * AI provider detection and resolution
 *
 * Determines which AI backend to use:
 * - SDK: Claude Agent SDK (subprocess-based, requires Claude Code installed)
 * - Anthropic: Direct Anthropic Messages API (requires ANTHROPIC_API_KEY)
 * - OpenAI: OpenAI-compatible API (requires OPENAI_API_KEY; supports OpenAI,
 *   OpenRouter, Ollama, Together, Groq, and any OpenAI-compatible endpoint
 *   via OPENAI_BASE_URL)
 *
 * Resolution order:
 * 1. Per-feature mode (off / sdk / api) — determined per user per feature
 * 2. For 'api' mode, admin config via OPENTASK_AI_PROVIDER env var
 * 3. Auto-detection: Anthropic → OpenAI (first available API key wins)
 */

import { log } from '@/lib/logger'

export type AIProvider = 'sdk' | 'anthropic' | 'openai'

// Cached detection results (set once, never change during process lifetime)
let sdkAvailable: boolean | null = null
let anthropicAvailable: boolean | null = null
let openaiAvailable: boolean | null = null

/** Check if the Claude Agent SDK is importable (Claude Code installed). */
export async function isSdkAvailable(): Promise<boolean> {
  if (sdkAvailable !== null) return sdkAvailable
  try {
    await import('@anthropic-ai/claude-agent-sdk')
    sdkAvailable = true
  } catch {
    sdkAvailable = false
  }
  return sdkAvailable
}

/**
 * Synchronous check — uses cached value from isSdkAvailable(), or falls back
 * to the env var set by initAI() (needed because Next.js may run route handlers
 * in a different module context than instrumentation.ts).
 */
export function isSdkAvailableSync(): boolean {
  if (sdkAvailable !== null) return sdkAvailable
  return process.env._OPENTASK_SDK_DETECTED === '1'
}

/** Check if the Anthropic API provider is available (ANTHROPIC_API_KEY set). */
export function isAnthropicAvailable(): boolean {
  if (anthropicAvailable !== null) return anthropicAvailable
  anthropicAvailable = !!process.env.ANTHROPIC_API_KEY
  return anthropicAvailable
}

/** Check if an OpenAI-compatible provider is available (OPENAI_API_KEY set). */
export function isOpenAIAvailable(): boolean {
  if (openaiAvailable !== null) return openaiAvailable
  openaiAvailable = !!process.env.OPENAI_API_KEY
  return openaiAvailable
}

/**
 * Normalize a provider string, mapping legacy 'api' to 'anthropic'.
 * Returns null for unrecognized values.
 */
function normalizeProvider(value: string): AIProvider | null {
  if (value === 'sdk' || value === 'anthropic' || value === 'openai') return value
  if (value === 'api') return 'anthropic' // backward compat
  return null
}

/**
 * Get the server-level default provider.
 *
 * Reads OPENTASK_AI_PROVIDER env var. If not set, auto-detects in order:
 * SDK → Anthropic → OpenAI (first available wins).
 */
export function getServerDefaultProvider(): AIProvider {
  const explicit = process.env.OPENTASK_AI_PROVIDER
  if (explicit) {
    const normalized = normalizeProvider(explicit)
    if (normalized) return normalized
  }

  // Auto-detect: SDK → Anthropic → OpenAI
  if (isSdkAvailableSync()) return 'sdk'
  if (isAnthropicAvailable()) return 'anthropic'
  if (isOpenAIAvailable()) return 'openai'

  // None available — default to SDK (initAI will report the error)
  return 'sdk'
}

// --- Model name resolution (Anthropic-specific) ---

/**
 * Map short model names to full Anthropic API model IDs.
 *
 * Applied by all providers (SDK and API) before making API calls.
 * Short names may appear in env var overrides or legacy DB values.
 * Dated snapshot IDs are used for reproducibility.
 *
 * Not used by the OpenAI provider — it passes model strings through as-is.
 */
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
}

/**
 * Resolve a model name to a full Anthropic API model ID.
 * Returns the input unchanged if no mapping exists (allows full IDs to pass through).
 */
export function resolveModelId(shortName: string): string {
  const mapped = ANTHROPIC_MODEL_MAP[shortName]
  if (mapped) return mapped

  // Log unknown model names to help catch typos
  if (!shortName.includes('-')) {
    log.warn('ai', `Unknown short model name "${shortName}" — passing through as-is`)
  }
  return shortName
}
