/**
 * Notification action callbacks
 *
 * POST /api/notifications/actions - Handle notification action callbacks (done, snooze)
 *
 * Body: { action: "done" | "snooze" | "snooze30" | "snooze2h", task_id: number, token: string }
 */

import { NextRequest } from 'next/server'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { validateBearerToken } from '@/core/auth/bearer'
import { markDone, snoozeTask } from '@/core/tasks'
import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { dismissApnsNotifications } from '@/core/notifications/apns'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
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

    if (!task_id || typeof task_id !== 'number') {
      return badRequest('task_id required')
    }

    // Dismiss notifications fire-and-forget (before switch so it runs for all actions)
    const dismissAfter = () => {
      dismissTaskNotifications(user.id, [task_id]).catch((err) =>
        log.error('api', 'Dismiss notification error:', err),
      )
      dismissApnsNotifications(user.id, [task_id]).catch((err) =>
        log.error('api', 'Dismiss APNs notification error:', err),
      )
    }

    switch (action) {
      case 'done': {
        const result = markDone({
          userId: user.id,
          taskId: task_id,
          userTimezone: user.timezone,
        })
        dismissAfter()
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
        return success({ action: 'snooze2h', task_id, until: until.toISOString(), result })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('api', 'POST /api/notifications/actions error:', err)
    return handleError(err)
  }
}
