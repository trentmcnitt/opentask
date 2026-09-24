/**
 * Mark Done API route
 *
 * POST /api/tasks/:id/done - Mark a task as done
 *
 * For recurring tasks: advances due_at to next occurrence
 * For one-off tasks: sets done=1 and archives
 * Quotas (§5): refused unless the body has `close_period: true`
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { markDone } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
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
    const taskId = parseInt(id)

    if (isNaN(taskId)) {
      return notFound('Task not found', { id })
    }

    // Optional body. Every existing caller (web, iOS) POSTs with no body at
    // all, so this must not throw on an empty or non-JSON one. The only field
    // is §5's `close_period`: completing a quota is refused without it (it
    // closes the period early and resets the count — see markDone).
    const body = (await request.json().catch(() => null)) as { close_period?: unknown } | null
    const closePeriod = body?.close_period === true

    const result = markDone({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      closePeriod,
    })

    dismissNotificationsForTasks(user.id, [taskId])
    notifyDemoEngagement(user.name, 'done')

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
})
