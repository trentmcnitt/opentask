/**
 * Centralized AI model resolution
 *
 * Single source of truth for which model each AI feature uses.
 * No hardcoded defaults — every feature must have its model explicitly configured
 * via per-feature env var (e.g., OPENTASK_AI_ENRICHMENT_MODEL).
 *
 * Resolution: per-feature env var → null (requireFeatureModel throws).
 */

import { isSdkAvailableSync } from './provider'
import type { FeatureMode } from './user-context'

export type AIFeature = 'enrichment' | 'quick_take' | 'whats_next' | 'insights'

export const AI_FEATURES: AIFeature[] = ['enrichment', 'quick_take', 'whats_next', 'insights']

export const FEATURE_ENV_VARS: Record<AIFeature, string> = {
  enrichment: 'OPENTASK_AI_ENRICHMENT_MODEL',
  quick_take: 'OPENTASK_AI_QUICKTAKE_MODEL',
  whats_next: 'OPENTASK_AI_WHATS_NEXT_MODEL',
  insights: 'OPENTASK_AI_INSIGHTS_MODEL',
}

/**
 * Resolve the model for a feature.
 * Returns the per-feature env var value, or null if not set.
 */
export function resolveFeatureModel(feature: AIFeature): string | null {
  return process.env[FEATURE_ENV_VARS[feature]] || null
}

/**
 * Same as resolveFeatureModel but throws on null.
 * Used at call sites where a model is required.
 */
export function requireFeatureModel(feature: AIFeature): string {
  const model = resolveFeatureModel(feature)
  if (!model) {
    throw new Error(
      `No model configured for feature '${feature}'. Set ${FEATURE_ENV_VARS[feature]}.`,
    )
  }
  return model
}

// --- Per-feature provider resolution ---

export type FeatureProviderType = 'anthropic' | 'openai'

export interface FeatureProviderConfig {
  providerType: FeatureProviderType
  apiKey: string
  baseUrl?: string
}

/** Env var prefixes for per-feature provider config. */
const FEATURE_ENV_PREFIXES: Record<AIFeature, string> = {
  enrichment: 'OPENTASK_AI_ENRICHMENT',
  quick_take: 'OPENTASK_AI_QUICKTAKE',
  whats_next: 'OPENTASK_AI_WHATS_NEXT',
  insights: 'OPENTASK_AI_INSIGHTS',
}

/**
 * Resolve the provider config for a specific feature.
 *
 * Per-feature env vars (e.g., OPENTASK_AI_ENRICHMENT_PROVIDER) take precedence
 * over global env vars (OPENTASK_AI_PROVIDER, ANTHROPIC_API_KEY, etc.).
 *
 * Returns null if no API provider can be resolved (no keys configured).
 */
export function resolveFeatureProvider(feature: AIFeature): FeatureProviderConfig | null {
  const prefix = FEATURE_ENV_PREFIXES[feature]

  // Per-feature provider type
  const perFeatureProvider = process.env[`${prefix}_PROVIDER`] as FeatureProviderType | undefined
  // Per-feature API key and base URL
  const perFeatureKey = process.env[`${prefix}_API_KEY`]
  const perFeatureBaseUrl = process.env[`${prefix}_BASE_URL`]

  // If per-feature provider is explicitly set, use it
  if (perFeatureProvider === 'anthropic' || perFeatureProvider === 'openai') {
    const apiKey = resolveApiKey(perFeatureProvider, perFeatureKey)
    if (!apiKey) {
      throw new Error(
        `Feature '${feature}' is configured for provider '${perFeatureProvider}' ` +
          `but no API key is available. Set ${prefix}_API_KEY or the global key ` +
          `(${perFeatureProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}).`,
      )
    }
    return {
      providerType: perFeatureProvider,
      apiKey,
      baseUrl:
        perFeatureProvider === 'openai'
          ? perFeatureBaseUrl || process.env.OPENAI_BASE_URL
          : undefined,
    }
  }

  // Fall back to global provider resolution
  const globalProvider = resolveGlobalProviderType()
  if (!globalProvider) return null

  const apiKey = resolveApiKey(globalProvider, perFeatureKey)
  if (!apiKey) return null

  return {
    providerType: globalProvider,
    apiKey,
    baseUrl:
      globalProvider === 'openai' ? perFeatureBaseUrl || process.env.OPENAI_BASE_URL : undefined,
  }
}

/**
 * Resolve the global provider type from OPENTASK_AI_PROVIDER or auto-detect from keys.
 */
function resolveGlobalProviderType(): FeatureProviderType | null {
  const explicit = process.env.OPENTASK_AI_PROVIDER
  if (explicit === 'anthropic' || explicit === 'openai') return explicit
  // Legacy 'api' value maps to anthropic
  if (explicit === 'api') return 'anthropic'

  // Auto-detect from available keys
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return null
}

/**
 * Resolve the API key: per-feature key → global key for the provider type.
 */
function resolveApiKey(providerType: FeatureProviderType, perFeatureKey?: string): string | null {
  if (perFeatureKey) return perFeatureKey
  if (providerType === 'anthropic') return process.env.ANTHROPIC_API_KEY || null
  return process.env.OPENAI_API_KEY || null
}

// --- Convenience: combined provider + model resolution ---

export interface FeatureAIConfig {
  provider: 'sdk' | 'anthropic' | 'openai'
  providerConfig?: FeatureProviderConfig
  model: string
}

/**
 * Resolve the full AI config for a feature given its mode.
 * Combines provider resolution + model resolution into a single call.
 *
 * For 'sdk' mode: returns provider='sdk', no providerConfig, model from env var.
 * For 'api' mode: resolves per-feature provider config + model.
 *
 * Throws if model or API key is missing.
 */
export function resolveFeatureAIConfig(feature: AIFeature, mode: FeatureMode): FeatureAIConfig {
  if (mode === 'off') {
    throw new Error(
      `Cannot resolve AI config for feature '${feature}' — mode is 'off'. ` +
        `Callers must check the mode before calling resolveFeatureAIConfig().`,
    )
  }

  const model = requireFeatureModel(feature)

  if (mode === 'sdk') {
    return { provider: 'sdk', model }
  }

  // mode === 'api'
  const providerConfig = resolveFeatureProvider(feature)
  if (!providerConfig) {
    throw new Error(
      `No API provider configured for feature '${feature}'. ` +
        `Set ${FEATURE_ENV_PREFIXES[feature]}_PROVIDER and an API key, ` +
        `or configure a global provider (ANTHROPIC_API_KEY / OPENAI_API_KEY).`,
    )
  }

  return {
    provider: providerConfig.providerType,
    providerConfig,
    model,
  }
}

// --- Feature info resolution (for UI display) ---

/** Human-friendly provider display names. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  sdk: 'Claude Code (SDK)',
  anthropic: 'Anthropic API',
  openai: 'OpenAI-compatible API',
}

export interface FeatureInfo {
  mode: FeatureMode
  provider: 'sdk' | 'anthropic' | 'openai' | null
  provider_display: string | null
  model: string | null
  model_display: string | null
  available: boolean
}

/**
 * Build a provider display string. For OpenAI-compatible providers with a
 * non-default base URL, appends the host (e.g., "OpenAI-compatible (api.x.ai)").
 */
function formatProviderDisplay(providerType: FeatureProviderType, baseUrl?: string): string {
  const base = PROVIDER_DISPLAY_NAMES[providerType] ?? providerType
  if (providerType === 'openai' && baseUrl) {
    try {
      const host = new URL(baseUrl).host
      // Only annotate non-default hosts
      if (host !== 'api.openai.com') {
        return `${base} (${host})`
      }
    } catch {
      // Invalid URL, just use base name
    }
  }
  return base
}

/**
 * Resolve full display info for a single feature given its mode.
 * Used by the preferences API to tell the UI what model/provider backs each feature.
 */
export function getFeatureInfo(feature: AIFeature, mode: FeatureMode): FeatureInfo {
  if (mode === 'off') {
    return {
      mode,
      provider: null,
      provider_display: null,
      model: null,
      model_display: null,
      available: true,
    }
  }

  if (mode === 'sdk') {
    const model = resolveFeatureModel(feature)
    return {
      mode,
      provider: 'sdk',
      provider_display: PROVIDER_DISPLAY_NAMES.sdk,
      model,
      model_display: model,
      available: isSdkAvailableSync(),
    }
  }

  // mode === 'api'
  try {
    const providerConfig = resolveFeatureProvider(feature)
    if (!providerConfig) {
      return {
        mode,
        provider: null,
        provider_display: null,
        model: null,
        model_display: null,
        available: false,
      }
    }
    const model = resolveFeatureModel(feature)
    return {
      mode,
      provider: providerConfig.providerType,
      provider_display: formatProviderDisplay(providerConfig.providerType, providerConfig.baseUrl),
      model,
      model_display: model,
      available: true,
    }
  } catch {
    return {
      mode,
      provider: null,
      provider_display: null,
      model: null,
      model_display: null,
      available: false,
    }
  }
}

/**
 * Check if any API provider is available (global or per-feature).
 * Used by the preferences endpoint to set ai_api_available.
 */
export function isAnyApiProviderAvailable(): boolean {
  // Check global keys
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return true
  // Check per-feature keys
  for (const feature of AI_FEATURES) {
    const prefix = FEATURE_ENV_PREFIXES[feature]
    if (process.env[`${prefix}_API_KEY`]) return true
  }
  return false
}
