/**
 * GET /api/ai/insights/status?session_id=X — Poll insights generation progress
 *
 * Returns the session status, progress count, and percentage.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { getInsightsSessionStatus } from '@/core/ai'
import { success, unauthorized, badRequest, notFound, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    const sessionId = request.nextUrl.searchParams.get('session_id')
    if (!sessionId) {
      return badRequest('session_id query parameter is required')
    }

    const session = getInsightsSessionStatus(sessionId, user.id)
    if (!session) {
      return notFound('Insights session not found')
    }

    return success({
      session_id: session.id,
      status: session.status,
      total_tasks: session.total_tasks,
      completed: session.completed,
      progress_pct:
        session.total_tasks > 0 ? Math.round((session.completed / session.total_tasks) * 100) : 0,
      started_at: session.started_at,
      finished_at: session.finished_at,
      error: session.error,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/ai/insights/status error:', err)
    return handleError(err)
  }
})
