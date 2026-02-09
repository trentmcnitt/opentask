import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, serviceUnavailable } from '@/lib/api-response'
import { isAIEnabled, getBriefing, buildTaskSummaries } from '@/core/ai'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isAIEnabled()) {
      return serviceUnavailable('AI features are not enabled')
    }

    const url = new URL(request.url)
    const refresh = url.searchParams.get('refresh') === 'true'

    const taskSummaries = buildTaskSummaries(user.id)
    const result = await getBriefing(user.id, user.timezone, taskSummaries, refresh)

    if (!result) {
      return serviceUnavailable('Failed to generate briefing')
    }

    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/briefing error:', err)
    return handleError(err)
  }
}
