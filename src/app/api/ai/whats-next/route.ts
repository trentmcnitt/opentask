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

    // §7.4: generation happens on the daily schedule or on an explicit refresh —
    // NEVER as a side effect of a page load. This route is hit on every mount of
    // the dashboard, so generating on a cache miss meant the first visit of each
    // day silently burned a full AI run. On a miss we return no data and let the
    // UI offer a refresh; the user asks for it, or the 3 AM job supplies it.
    if (!refresh) {
      const cached = getCachedWhatsNext(user.id)
      if (cached) {
        return success({ ...cached.result, duration_ms: cached.durationMs })
      }
      return success(null)
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
