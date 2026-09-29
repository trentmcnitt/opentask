/**
 * Notification action callbacks
 *
 * POST /api/notifications/actions - Handle notification action callbacks (done, snooze)
 *
 * Body: { action: "done" | "snooze" | "snooze30" | "snooze2h", task_id: number, token: string }
 *
 * Auth: Token is passed in the request body (not the Authorization header) because iOS
 * Notification Content Extensions cannot set custom HTTP headers. The extension reads
 * the token from the shared Keychain (App Group) and includes it in the JSON body.
 */

import { NextRequest } from 'next/server'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { validateBearerToken } from '@/core/auth/bearer'
import { markDone, snoozeTask } from '@/core/tasks'
import { log } from '@/lib/logger'
import { computeSnoozeTime } from '@/lib/snooze'
import { withLogging } from '@/lib/with-logging'

/**
 * Snooze length in minutes per notification action. `computeSnoozeTime` (the
 * same helper as the app's snooze buttons) makes 30 exact minutes from now and
 * snaps the hour-based ones to the top of the hour.
 */
const SNOOZE_MINUTES: Record<string, number> = { snooze30: 30, snooze: 60, snooze2h: 120 }

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, task_id, token } = body

    if (!token || typeof token !== 'string') {
      return unauthorized('Token required')
    }

    // Validate the bearer token
    const user = validateBearerToken(token)
    if (!user) {
      return unauthorized('Invalid token')
    }

    if (!task_id || typeof task_id !== 'number' || !Number.isInteger(task_id) || task_id <= 0) {
      return badRequest('task_id must be a positive integer')
    }

    log.info('notifications', `Action received: ${action} on task ${task_id} by user ${user.id}`)

    // markDone and snoozeTask dismiss the task's notification on every device
    // themselves (fire-and-forget), so nothing more is needed here.
    switch (action) {
      case 'done': {
        const result = markDone({
          userId: user.id,
          taskId: task_id,
          userTimezone: user.timezone,
        })
        log.info('notifications', `Action complete: done on task ${task_id}`)
        return success({ action: 'done', task_id, result })
      }

      case 'snooze30':
      case 'snooze':
      case 'snooze2h': {
        // Only the minute options are passed, so the morning time is unused.
        const until = computeSnoozeTime(String(SNOOZE_MINUTES[action]), user.timezone, '')
        const result = snoozeTask({
          userId: user.id,
          userTimezone: user.timezone,
          taskId: task_id,
          until,
        })
        log.info('notifications', `Action complete: ${action} on task ${task_id}`)
        return success({ action, task_id, until, result })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('api', 'POST /api/notifications/actions error:', err)
    return handleError(err)
  }
})
