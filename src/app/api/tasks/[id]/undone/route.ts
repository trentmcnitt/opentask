/**
 * Mark Undone API route
 *
 * POST /api/tasks/:id/undone - Mark a one-off task as undone (reopen)
 *
 * Note: For recurring tasks, use /api/undo instead.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { markUndone } from '@/core/tasks'
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

    const task = markUndone({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
    })

    return success({
      ...task,
      is_recurring: task.rrule !== null,
      is_snoozed: task.snoozed_from !== null,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('POST /api/tasks/:id/undone error:', err)
    return handleError(err)
  }
}
