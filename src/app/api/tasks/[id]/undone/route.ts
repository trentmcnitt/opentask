/**
 * Mark Undone API route
 *
 * POST /api/tasks/:id/undone - Mark a one-off task as undone (reopen)
 *
 * Note: For recurring tasks, use /api/undo instead.
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, unauthorized, badRequest, handleError, parseRouteId } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { markUndone } from '@/core/tasks'
import { log } from '@/lib/logger'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const task = markUndone({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
    })

    notifyDemoEngagement(user.name, 'update')
    return success(formatTaskResponse(task))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/:id/undone error:', err)
    return handleError(err)
  }
})
