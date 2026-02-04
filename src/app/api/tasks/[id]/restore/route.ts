/**
 * Restore API route
 *
 * POST /api/tasks/:id/restore - Restore a task from trash
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { restoreTask } from '@/core/tasks'
import { log } from '@/lib/logger'
import type { RouteContext } from '@/types/api'

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { id } = await context.params
    const taskId = parseInt(id)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }

    const task = restoreTask({
      userId: user.id,
      taskId,
    })

    return success({
      ...formatTaskResponse(task),
      message: 'Task restored from trash',
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/tasks/:id/restore error:', err)
    return handleError(err)
  }
}
