/**
 * Quota stats API
 *
 * GET /api/tasks/:id/quota-stats - A quota's record over its closed periods:
 * periods met and missed, the current streak and the longest one.
 *
 * Read when a quota chip's bubble opens (`TrackChipPopover`), one quota at a
 * time, rather than added to the task payload: `GET /api/tasks` and
 * `GET /api/tasks/:id` are native-app contract endpoints, and nothing but the
 * bubble wants these numbers. See `getQuotaStats` for what counts.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, handleError, parseRouteId } from '@/lib/api-response'
import { getQuotaStats } from '@/core/tasks/quotas'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')
    return success(getQuotaStats(user.id, taskId))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/tasks/:id/quota-stats error:', err)
    return handleError(err)
  }
})
