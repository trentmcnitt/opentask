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
import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { dismissApnsNotifications } from '@/core/notifications/apns'
import { validateBulkSnooze } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
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

    dismissTaskNotifications(user.id, input.ids).catch((err) =>
      log.error('api', 'Dismiss notification error:', err),
    )
    dismissApnsNotifications(user.id, input.ids).catch((err) =>
      log.error('api', 'Dismiss APNs notification error:', err),
    )

    return success({
      tasks_affected: result.tasksAffected,
      tasks_skipped: result.tasksSkipped,
      tier: result.tier,
      skipped_medium: result.skippedByPriority.medium,
      skipped_high: result.skippedByPriority.high,
      skipped_urgent: result.skippedByPriority.urgent,
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
}
