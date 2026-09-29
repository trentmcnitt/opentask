/**
 * Restore API route
 *
 * POST /api/tasks/:id/restore - Restore a task from trash
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, unauthorized, badRequest, handleError, parseRouteId } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { restoreTask } from '@/core/tasks'
import { log } from '@/lib/logger'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const task = restoreTask({
      userId: user.id,
      taskId,
    })

    return success({
      ...formatTaskResponse(task),
      message: 'Task restored from trash',
    })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/:id/restore error:', err)
    return handleError(err)
  }
})
