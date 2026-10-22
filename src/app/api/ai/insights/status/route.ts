/**
 * SHELVED (2026-10-22): Insights (this route answers 410 FEATURE_SHELVED) is shelved behind `OPENTASK_AI_UNSHELVE`
 * (src/core/ai/shelved.ts) until it is redesigned. The code stays in place,
 * dormant — do not "fix" or re-enable it without Trent.
 */
/**
 * GET /api/ai/insights/status?session_id=X — Poll insights generation progress
 *
 * Returns the session status, progress count, and percentage.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { getInsightsSessionStatus } from '@/core/ai'
import {
  success,
  unauthorized,
  badRequest,
  notFound,
  handleError,
  featureShelved,
} from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { shelvedAiFeaturesOn } from '@/core/ai/shelved'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    // SHELVED (2026-10-22): src/core/ai/shelved.ts. After auth (a bad token
    // is still a 401), before the AI-enabled check.
    if (!shelvedAiFeaturesOn()) return featureShelved()

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
