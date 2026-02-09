import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import { isAIEnabled, generateBubble, getCachedBubble, buildTaskSummaries } from '@/core/ai'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const { searchParams } = new URL(request.url)
    const refresh = searchParams.get('refresh') === 'true'

    // Return cached result if available and not requesting refresh
    if (!refresh) {
      const cached = getCachedBubble(user.id)
      if (cached) {
        return success(cached)
      }
    }

    // Generate fresh recommendations
    const taskSummaries = buildTaskSummaries(user.id)
    const result = await generateBubble(user.id, user.timezone, taskSummaries)

    if (!result) {
      return serviceUnavailable('Failed to generate recommendations')
    }

    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/bubble error:', err)
    return handleError(err)
  }
}
