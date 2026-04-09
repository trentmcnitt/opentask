import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import {
  isAIEnabled,
  generateWhatsNext,
  getCachedWhatsNext,
  buildTaskSummaries,
  getUserAiContext,
  resolveFeatureAIConfig,
} from '@/core/ai'
import { getUserFeatureModes } from '@/core/ai/user-context'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const modes = getUserFeatureModes(user.id)
    if (modes.whats_next === 'off') {
      return serviceUnavailable("What's Next is disabled")
    }

    const { searchParams } = new URL(request.url)
    const refresh = searchParams.get('refresh') === 'true'

    // Return cached result if available and not requesting refresh
    if (!refresh) {
      const cached = getCachedWhatsNext(user.id)
      if (cached) {
        return success({ ...cached.result, duration_ms: cached.durationMs })
      }
    }

    // Generate fresh recommendations
    const taskSummaries = buildTaskSummaries(user.id)
    const aiContext = getUserAiContext(user.id)
    const aiConfig = resolveFeatureAIConfig('whats_next', modes.whats_next)
    const result = await generateWhatsNext(
      user.id,
      user.timezone,
      taskSummaries,
      aiContext,
      aiConfig,
      'on-demand',
    )

    if (!result) {
      return serviceUnavailable('Failed to generate recommendations')
    }

    // Re-fetch from cache to get the logged duration_ms
    const fresh = getCachedWhatsNext(user.id)
    return success({ ...result, duration_ms: fresh?.durationMs ?? null })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/whats-next error:', err)
    return handleError(err)
  }
})
