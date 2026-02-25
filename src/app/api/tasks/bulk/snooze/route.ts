/**
 * Bulk Snooze API route
 *
 * POST /api/tasks/bulk/snooze - Snooze multiple tasks
 *
 * Body (absolute mode): { ids: [1, 2, 3, ...], until: "ISO8601 datetime" }
 * Body (relative mode): { ids: [1, 2, 3, ...], delta_minutes: 60 }
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { validateBulkSnooze } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const input = validateBulkSnooze(body)

    const result = bulkSnooze({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds: input.ids,
      until: input.until,
      deltaMinutes: input.delta_minutes,
    })

    dismissNotificationsForTasks(user.id, input.ids)
    notifyDemoEngagement(user.name, 'update')

    return success({
      tasks_affected: result.tasksAffected,
      tasks_skipped: result.tasksSkipped,
      skipped_urgent: result.urgentSkipped,
      skipped_no_due_date: result.noDueDateSkipped,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks/bulk/snooze error:', err)
    return handleError(err)
  }
})
