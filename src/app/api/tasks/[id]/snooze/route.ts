/**
 * Snooze API route
 *
 * POST /api/tasks/:id/snooze - Snooze a task to a future time
 *
 * Body: { until: "ISO8601 datetime" }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { snoozeTask } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { validateSnooze } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
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

    const body = await request.json()
    const input = validateSnooze(body)

    const result = snoozeTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      until: input.until,
    })

    dismissNotificationsForTasks(user.id, [taskId])
    notifyDemoEngagement(user.name, 'update')

    return success({
      task: formatTaskResponse(result.task),
      previous_due_at: result.previousDueAt,
      original_due_at: result.originalDueAt,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks/:id/snooze error:', err)
    return handleError(err)
  }
})
