/**
 * Mark Done API route
 *
 * POST /api/tasks/:id/done - Mark a task as done
 *
 * For recurring tasks: advances due_at to next occurrence
 * For one-off tasks: sets done=1 and archives
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { markDone } from '@/core/tasks'
import { dismissAllNotifications } from '@/core/notifications/dismiss'
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

    const result = markDone({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
    })

    dismissAllNotifications(user.id, [taskId])

    return success({
      task: formatTaskResponse(result.task),
      was_recurring: result.wasRecurring,
      next_due_at: result.nextDueAt,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/tasks/:id/done error:', err)
    return handleError(err)
  }
}
