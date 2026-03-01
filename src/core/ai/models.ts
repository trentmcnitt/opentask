/**
 * Centralized AI model resolution
 *
 * Single source of truth for which model each AI feature uses.
 * Replaces 13+ scattered `|| 'haiku'` patterns across the codebase.
 *
 * Resolution order:
 * 1. Per-feature env var (e.g., OPENTASK_AI_ENRICHMENT_MODEL) — always wins
 * 2. Provider-level default — SDK/Anthropic have sensible defaults, OpenAI uses OPENAI_MODEL
 *
 * No silent fallbacks: if OpenAI is the provider and no model is configured,
 * resolution returns null (requireFeatureModel throws).
 */

import type { AIProvider } from './provider'
import { isSdkAvailableSync, getApiProvider } from './provider'
import type { FeatureMode } from './user-context'

export type AIFeature = 'enrichment' | 'quick_take' | 'whats_next' | 'insights'

export const AI_FEATURES: AIFeature[] = ['enrichment', 'quick_take', 'whats_next', 'insights']

const FEATURE_ENV_VARS: Record<AIFeature, string> = {
  enrichment: 'OPENTASK_AI_ENRICHMENT_MODEL',
  quick_take: 'OPENTASK_AI_QUICKTAKE_MODEL',
  whats_next: 'OPENTASK_AI_WHATS_NEXT_MODEL',
  insights: 'OPENTASK_AI_INSIGHTS_MODEL',
}

/** Defaults for SDK/Anthropic when no per-feature env var is set. */
const ANTHROPIC_DEFAULTS: Record<AIFeature, string> = {
  enrichment: 'haiku',
  quick_take: 'sonnet',
  whats_next: 'haiku',
  insights: 'claude-opus-4-6',
}

/**
 * Resolve the model for a feature + provider.
 * Returns null when OpenAI has no model configured.
 */
export function resolveFeatureModel(feature: AIFeature, provider: AIProvider): string | null {
  const explicit = process.env[FEATURE_ENV_VARS[feature]]
  if (explicit) return explicit

  if (provider === 'openai') return process.env.OPENAI_MODEL || null
  return ANTHROPIC_DEFAULTS[feature]
}

/**
 * Same as resolveFeatureModel but throws on null.
 * Used at call sites where a model is required.
 */
export function requireFeatureModel(feature: AIFeature, provider: AIProvider): string {
  const model = resolveFeatureModel(feature, provider)
  if (!model) {
    throw new Error(
      `No model configured for feature '${feature}' with provider '${provider}'. ` +
        `Set ${FEATURE_ENV_VARS[feature]} or OPENAI_MODEL.`,
    )
  }
  return model
}

// --- Feature info resolution (for UI display) ---

/** Human-friendly model display names for the settings UI and AI status modal. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  haiku: 'Claude Haiku 4.5',
  sonnet: 'Claude Sonnet 4.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-sonnet-4-5-20250514': 'Claude Sonnet 4.5',
  'claude-opus-4-6-20250610': 'Claude Opus 4.6',
}

/** Human-friendly provider display names. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  sdk: 'Claude Code (SDK)',
  anthropic: 'Anthropic API',
  openai: 'OpenAI-compatible API',
}

export interface FeatureInfo {
  mode: FeatureMode
  provider: AIProvider | null
  provider_display: string | null
  model: string | null
  model_display: string | null
  available: boolean
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
    const model = resolveFeatureModel(feature, 'sdk')
    return {
      mode,
      provider: 'sdk',
      provider_display: PROVIDER_DISPLAY_NAMES.sdk,
      model,
      model_display: model ? (MODEL_DISPLAY_NAMES[model] ?? model) : null,
      available: isSdkAvailableSync(),
    }
  }

  // mode === 'api'
  try {
    const apiProvider = getApiProvider()
    const model = resolveFeatureModel(feature, apiProvider)
    return {
      mode,
      provider: apiProvider,
      provider_display: PROVIDER_DISPLAY_NAMES[apiProvider] ?? apiProvider,
      model,
      model_display: model ? (MODEL_DISPLAY_NAMES[model] ?? model) : null,
      available: true,
    }
  } catch {
    // getApiProvider() throws when no API key is configured
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
