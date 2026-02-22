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
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

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

    // Dismiss notifications fire-and-forget (before switch so it runs for all actions)
    const dismissAfter = () => dismissNotificationsForTasks(user.id, [task_id])

    switch (action) {
      case 'done': {
        const result = markDone({
          userId: user.id,
          taskId: task_id,
          userTimezone: user.timezone,
        })
        dismissAfter()
        log.info('notifications', `Action complete: done on task ${task_id}`)
        return success({ action: 'done', task_id, result })
      }

      case 'snooze30': {
        const until = new Date(Date.now() + 30 * 60 * 1000)
        const result = snoozeTask({
          userId: user.id,
          userTimezone: user.timezone,
          taskId: task_id,
          until: until.toISOString(),
        })
        dismissAfter()
        log.info('notifications', `Action complete: snooze30 on task ${task_id}`)
        return success({ action: 'snooze30', task_id, until: until.toISOString(), result })
      }

      case 'snooze': {
        const until = new Date(Date.now() + 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        const result = snoozeTask({
          userId: user.id,
          userTimezone: user.timezone,
          taskId: task_id,
          until: until.toISOString(),
        })
        dismissAfter()
        log.info('notifications', `Action complete: snooze on task ${task_id}`)
        return success({ action: 'snooze', task_id, until: until.toISOString(), result })
      }

      case 'snooze2h': {
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        const result = snoozeTask({
          userId: user.id,
          userTimezone: user.timezone,
          taskId: task_id,
          until: until.toISOString(),
        })
        dismissAfter()
        log.info('notifications', `Action complete: snooze2h on task ${task_id}`)
        return success({ action: 'snooze2h', task_id, until: until.toISOString(), result })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('api', 'POST /api/notifications/actions error:', err)
    return handleError(err)
  }
})
