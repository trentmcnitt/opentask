/**
 * AI per-feature provider routing tests
 *
 * Tests the per-feature provider resolution: env var hierarchy, mixed configs,
 * error handling for missing keys/models, and client caching.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'

// Save and restore env vars between tests
const originalEnv = { ...process.env }

function clearAIEnv() {
  // Clear all AI-related env vars
  const prefixes = [
    'OPENTASK_AI_PROVIDER',
    'OPENTASK_AI_SDK_MODEL',
    'OPENTASK_AI_ENRICHMENT',
    'OPENTASK_AI_QUICKTAKE',
    'OPENTASK_AI_WHATS_NEXT',
    'OPENTASK_AI_INSIGHTS',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
  ]
  for (const key of Object.keys(process.env)) {
    if (prefixes.some((p) => key.startsWith(p))) {
      delete process.env[key]
    }
  }
}

beforeEach(() => {
  clearAIEnv()
})

afterEach(() => {
  // Restore original env
  clearAIEnv()
  Object.assign(process.env, originalEnv)
})

// Import after env setup to avoid caching issues
// We use dynamic imports in each test to ensure fresh env reads
async function getModels() {
  // Force fresh module evaluation by clearing module cache
  const mod = await import('@/core/ai/models')
  return mod
}

describe('resolveFeatureModel', () => {
  test('returns per-feature env var when set', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'claude-haiku-4-5-20251001'
    const { resolveFeatureModel } = await getModels()
    expect(resolveFeatureModel('enrichment')).toBe('claude-haiku-4-5-20251001')
  })

  test('returns null when no model configured', async () => {
    const { resolveFeatureModel } = await getModels()
    expect(resolveFeatureModel('enrichment')).toBeNull()
  })

  test('each feature reads its own env var', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'model-a'
    process.env.OPENTASK_AI_QUICKTAKE_MODEL = 'model-b'
    process.env.OPENTASK_AI_WHATS_NEXT_MODEL = 'model-c'
    process.env.OPENTASK_AI_INSIGHTS_MODEL = 'model-d'
    const { resolveFeatureModel } = await getModels()
    expect(resolveFeatureModel('enrichment')).toBe('model-a')
    expect(resolveFeatureModel('quick_take')).toBe('model-b')
    expect(resolveFeatureModel('whats_next')).toBe('model-c')
    expect(resolveFeatureModel('insights')).toBe('model-d')
  })
})

describe('requireFeatureModel', () => {
  test('returns model when configured', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'
    const { requireFeatureModel } = await getModels()
    expect(requireFeatureModel('enrichment')).toBe('test-model')
  })

  test('throws with clear message when no model configured', async () => {
    const { requireFeatureModel } = await getModels()
    expect(() => requireFeatureModel('enrichment')).toThrow(
      "No model configured for feature 'enrichment'. Set OPENTASK_AI_ENRICHMENT_MODEL.",
    )
  })

  test('throws with feature-specific env var name', async () => {
    const { requireFeatureModel } = await getModels()
    expect(() => requireFeatureModel('quick_take')).toThrow('OPENTASK_AI_QUICKTAKE_MODEL')
    expect(() => requireFeatureModel('whats_next')).toThrow('OPENTASK_AI_WHATS_NEXT_MODEL')
    expect(() => requireFeatureModel('insights')).toThrow('OPENTASK_AI_INSIGHTS_MODEL')
  })
})

describe('resolveSDKModel', () => {
  test('returns per-feature SDK env var when set', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'haiku'
    const { resolveSDKModel } = await getModels()
    expect(resolveSDKModel('enrichment')).toBe('haiku')
  })

  test('falls back to global SDK model', async () => {
    process.env.OPENTASK_AI_SDK_MODEL = 'opus'
    const { resolveSDKModel } = await getModels()
    expect(resolveSDKModel('enrichment')).toBe('opus')
  })

  test('falls back to sonnet when nothing configured', async () => {
    const { resolveSDKModel } = await getModels()
    expect(resolveSDKModel('enrichment')).toBe('sonnet')
  })

  test('per-feature overrides global', async () => {
    process.env.OPENTASK_AI_SDK_MODEL = 'opus'
    process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'haiku'
    const { resolveSDKModel } = await getModels()
    expect(resolveSDKModel('enrichment')).toBe('haiku')
  })

  test('each feature reads its own SDK env var', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'haiku'
    process.env.OPENTASK_AI_QUICKTAKE_SDK_MODEL = 'sonnet'
    const { resolveSDKModel } = await getModels()
    expect(resolveSDKModel('enrichment')).toBe('haiku')
    expect(resolveSDKModel('quick_take')).toBe('sonnet')
    // Unconfigured features fall back to hardcoded default
    expect(resolveSDKModel('whats_next')).toBe('sonnet')
    expect(resolveSDKModel('insights')).toBe('sonnet')
  })

  test('is independent of API model env vars', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'grok-4-1-fast-non-reasoning'
    const { resolveSDKModel } = await getModels()
    // API model should not affect SDK model resolution
    expect(resolveSDKModel('enrichment')).toBe('sonnet')
  })
})

describe('resolveFeatureProvider', () => {
  test('returns null when no provider configured', async () => {
    const { resolveFeatureProvider } = await getModels()
    expect(resolveFeatureProvider('enrichment')).toBeNull()
  })

  test('uses global anthropic key when provider is anthropic', async () => {
    process.env.OPENTASK_AI_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('anthropic')
    expect(config!.apiKey).toBe('sk-ant-test')
    expect(config!.baseUrl).toBeUndefined()
  })

  test('uses global openai key and base URL when provider is openai', async () => {
    process.env.OPENTASK_AI_PROVIDER = 'openai'
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('openai')
    expect(config!.apiKey).toBe('sk-openai-test')
    expect(config!.baseUrl).toBe('https://api.x.ai/v1')
  })

  test('auto-detects anthropic from API key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-auto'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('anthropic')
  })

  test('auto-detects openai from API key', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-auto'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('openai')
  })

  test('per-feature provider overrides global', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-global'
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'openai'
    process.env.OPENTASK_AI_ENRICHMENT_API_KEY = 'xai-per-feature'
    process.env.OPENTASK_AI_ENRICHMENT_BASE_URL = 'https://api.x.ai/v1'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('openai')
    expect(config!.apiKey).toBe('xai-per-feature')
    expect(config!.baseUrl).toBe('https://api.x.ai/v1')
  })

  test('per-feature provider falls back to global key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-global'
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'anthropic'
    // No per-feature key set — should use global
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config).not.toBeNull()
    expect(config!.providerType).toBe('anthropic')
    expect(config!.apiKey).toBe('sk-ant-global')
  })

  test('throws when per-feature provider set but no key available', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'anthropic'
    // No ANTHROPIC_API_KEY, no per-feature key
    const { resolveFeatureProvider } = await getModels()
    expect(() => resolveFeatureProvider('enrichment')).toThrow(
      "Feature 'enrichment' is configured for provider 'anthropic' but no API key is available",
    )
  })

  test('different features can use different providers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-global'
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'anthropic'
    process.env.OPENTASK_AI_INSIGHTS_PROVIDER = 'openai'
    process.env.OPENTASK_AI_INSIGHTS_API_KEY = 'xai-insights'
    process.env.OPENTASK_AI_INSIGHTS_BASE_URL = 'https://api.x.ai/v1'
    const { resolveFeatureProvider } = await getModels()

    const enrichConfig = resolveFeatureProvider('enrichment')
    const insightsConfig = resolveFeatureProvider('insights')

    expect(enrichConfig!.providerType).toBe('anthropic')
    expect(enrichConfig!.apiKey).toBe('sk-ant-global')

    expect(insightsConfig!.providerType).toBe('openai')
    expect(insightsConfig!.apiKey).toBe('xai-insights')
    expect(insightsConfig!.baseUrl).toBe('https://api.x.ai/v1')
  })

  test('per-feature openai base URL overrides global base URL', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-global'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENTASK_AI_WHATS_NEXT_PROVIDER = 'openai'
    process.env.OPENTASK_AI_WHATS_NEXT_BASE_URL = 'https://api.x.ai/v1'
    const { resolveFeatureProvider } = await getModels()

    const config = resolveFeatureProvider('whats_next')
    expect(config!.baseUrl).toBe('https://api.x.ai/v1')
  })

  test('legacy api provider value maps to anthropic', async () => {
    process.env.OPENTASK_AI_PROVIDER = 'api'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-legacy'
    const { resolveFeatureProvider } = await getModels()
    const config = resolveFeatureProvider('enrichment')
    expect(config!.providerType).toBe('anthropic')
  })
})

describe('resolveFeatureAIConfig', () => {
  test('sdk mode uses SDK model, not API model', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'haiku'
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'grok-4-1-fast-non-reasoning'
    const { resolveFeatureAIConfig } = await getModels()
    const config = resolveFeatureAIConfig('enrichment', 'sdk')
    expect(config.provider).toBe('sdk')
    expect(config.model).toBe('haiku')
    expect(config.providerConfig).toBeUndefined()
  })

  test('sdk mode falls back to sonnet with no config', async () => {
    const { resolveFeatureAIConfig } = await getModels()
    const config = resolveFeatureAIConfig('enrichment', 'sdk')
    expect(config.provider).toBe('sdk')
    expect(config.model).toBe('sonnet')
  })

  test('api mode returns provider config', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'claude-haiku-4-5-20251001'
    const { resolveFeatureAIConfig } = await getModels()
    const config = resolveFeatureAIConfig('enrichment', 'api')
    expect(config.provider).toBe('anthropic')
    expect(config.model).toBe('claude-haiku-4-5-20251001')
    expect(config.providerConfig).toBeDefined()
    expect(config.providerConfig!.providerType).toBe('anthropic')
    expect(config.providerConfig!.apiKey).toBe('sk-ant-test')
  })

  test('api mode throws when model is missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const { resolveFeatureAIConfig } = await getModels()
    expect(() => resolveFeatureAIConfig('enrichment', 'api')).toThrow(
      "No model configured for feature 'enrichment'",
    )
  })

  test('sdk mode never throws on missing model (has fallback)', async () => {
    // No SDK model, no API model, no global SDK model — should still work
    const { resolveFeatureAIConfig } = await getModels()
    expect(() => resolveFeatureAIConfig('enrichment', 'sdk')).not.toThrow()
    expect(resolveFeatureAIConfig('enrichment', 'sdk').model).toBe('sonnet')
  })

  test('throws when API provider is missing', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'
    // No API keys configured
    const { resolveFeatureAIConfig } = await getModels()
    expect(() => resolveFeatureAIConfig('enrichment', 'api')).toThrow('No API provider configured')
  })

  test('mixed config: different providers per feature', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'anthropic'
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'claude-haiku-4-5-20251001'
    process.env.OPENTASK_AI_INSIGHTS_PROVIDER = 'openai'
    process.env.OPENTASK_AI_INSIGHTS_API_KEY = 'xai-test'
    process.env.OPENTASK_AI_INSIGHTS_BASE_URL = 'https://api.x.ai/v1'
    process.env.OPENTASK_AI_INSIGHTS_MODEL = 'grok-4-1-fast-non-reasoning'
    const { resolveFeatureAIConfig } = await getModels()

    const enrichConfig = resolveFeatureAIConfig('enrichment', 'api')
    expect(enrichConfig.provider).toBe('anthropic')
    expect(enrichConfig.model).toBe('claude-haiku-4-5-20251001')

    const insightsConfig = resolveFeatureAIConfig('insights', 'api')
    expect(insightsConfig.provider).toBe('openai')
    expect(insightsConfig.model).toBe('grok-4-1-fast-non-reasoning')
    expect(insightsConfig.providerConfig!.baseUrl).toBe('https://api.x.ai/v1')
  })
})

describe('isAnyApiProviderAvailable', () => {
  test('returns false when no keys configured', async () => {
    const { isAnyApiProviderAvailable } = await getModels()
    expect(isAnyApiProviderAvailable()).toBe(false)
  })

  test('returns true when global anthropic key set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const { isAnyApiProviderAvailable } = await getModels()
    expect(isAnyApiProviderAvailable()).toBe(true)
  })

  test('returns true when global openai key set', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    const { isAnyApiProviderAvailable } = await getModels()
    expect(isAnyApiProviderAvailable()).toBe(true)
  })

  test('returns true when per-feature key set (no global)', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_API_KEY = 'per-feature-key'
    const { isAnyApiProviderAvailable } = await getModels()
    expect(isAnyApiProviderAvailable()).toBe(true)
  })
})

describe('getFeatureInfo', () => {
  test('off mode returns available true', async () => {
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'off')
    expect(info.available).toBe(true)
    expect(info.provider).toBeNull()
    expect(info.model).toBeNull()
  })

  test('api mode with provider shows raw model string', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'claude-haiku-4-5-20251001'
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'api')
    expect(info.model).toBe('claude-haiku-4-5-20251001')
    // model_display should be the same raw string (no lookup table)
    expect(info.model_display).toBe('claude-haiku-4-5-20251001')
  })

  test('api mode with custom base URL shows host in provider display', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_PROVIDER = 'openai'
    process.env.OPENTASK_AI_ENRICHMENT_API_KEY = 'xai-test'
    process.env.OPENTASK_AI_ENRICHMENT_BASE_URL = 'https://api.x.ai/v1'
    process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'grok-4-1-fast'
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'api')
    expect(info.provider_display).toBe('OpenAI-compatible API (api.x.ai)')
  })

  test('api mode with no provider returns available false', async () => {
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'api')
    expect(info.available).toBe(false)
    expect(info.provider).toBeNull()
  })

  test('sdk mode returns SDK model and provider', async () => {
    process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'haiku'
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'sdk')
    expect(info.mode).toBe('sdk')
    expect(info.provider).toBe('sdk')
    expect(info.provider_display).toBe('Claude Code (SDK)')
    expect(info.model).toBe('haiku')
    expect(info.model_display).toBe('haiku')
  })

  test('sdk mode falls back to sonnet with no config', async () => {
    const { getFeatureInfo } = await getModels()
    const info = getFeatureInfo('enrichment', 'sdk')
    expect(info.model).toBe('sonnet')
  })
})
