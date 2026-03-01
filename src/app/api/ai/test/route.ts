/**
 * AI connectivity test endpoint
 *
 * POST /api/ai/test — sends a minimal prompt to verify that a feature's
 * configured model and provider respond correctly.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import {
  success,
  unauthorized,
  badRequest,
  serviceUnavailable,
  handleError,
} from '@/lib/api-response'
import { isAIEnabled, aiQuery } from '@/core/ai/sdk'
import { getFeatureInfo, AI_FEATURES, type AIFeature } from '@/core/ai/models'
import { getUserFeatureModes } from '@/core/ai/user-context'
import { resolveModelId } from '@/core/ai/provider'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const body = await request.json()
    const feature = body?.feature as string | undefined
    if (!feature || !AI_FEATURES.includes(feature as AIFeature)) {
      return badRequest(`Invalid feature. Must be one of: ${AI_FEATURES.join(', ')}`)
    }

    const modes = getUserFeatureModes(user.id)
    const featureKey = feature as AIFeature
    const mode = modes[featureKey]

    if (mode === 'off') {
      return badRequest('Feature is disabled. Set it to SDK or API mode first.')
    }

    const info = getFeatureInfo(featureKey, mode)
    if (!info.available || !info.provider || !info.model) {
      return badRequest(
        `Provider not available for ${feature} in ${mode} mode. ` +
          (mode === 'sdk'
            ? 'Claude Code is not installed on this server.'
            : 'No API key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY).'),
      )
    }

    // Resolve model ID for Anthropic API (SDK and OpenAI pass through as-is)
    const resolvedModel = info.provider === 'anthropic' ? resolveModelId(info.model) : info.model

    const result = await aiQuery({
      prompt: 'Reply with exactly: ok',
      model: resolvedModel,
      maxTurns: 1,
      timeoutMs: 15_000,
      userId: user.id,
      action: 'test',
      inputText: `Test: ${feature}`,
      provider: info.provider === 'sdk' ? undefined : info.provider,
    })

    return success({
      success: result.success,
      duration_ms: result.durationMs,
      provider: info.provider,
      provider_display: info.provider_display,
      model: info.model,
      model_display: info.model_display,
      error: result.error,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/ai/test error:', err)
    return handleError(err)
  }
})
