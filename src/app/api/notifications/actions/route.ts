/**
 * Notification action callbacks
 *
 * POST /api/notifications/actions - Handle ntfy action button callbacks
 *
 * Body: { action: "done" | "snooze" | "snooze30" | "snooze2h", task_id: number, token: string }
 */

import { NextRequest } from 'next/server'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { validateBearerToken } from '@/core/auth/bearer'
import { markDone, snoozeTask } from '@/core/tasks'

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

    switch (action) {
      case 'done': {
        const result = markDone({
          userId: user.id,
          taskId: task_id,
          userTimezone: user.timezone,
        })
        return success({ action: 'done', task_id, result })
      }

      case 'snooze30': {
        // Snooze by 30 minutes
        const until = new Date(Date.now() + 30 * 60 * 1000)
        const result = snoozeTask({
          userId: user.id,
          taskId: task_id,
          until: until.toISOString(),
        })
        return success({ action: 'snooze30', task_id, until: until.toISOString(), result })
      }

      case 'snooze': {
        // Snooze by 1 hour (rounded to the hour)
        const until = new Date(Date.now() + 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        const result = snoozeTask({
          userId: user.id,
          taskId: task_id,
          until: until.toISOString(),
        })
        return success({ action: 'snooze', task_id, until: until.toISOString(), result })
      }

      case 'snooze2h': {
        // Snooze by 2 hours (rounded to the hour)
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        const result = snoozeTask({
          userId: user.id,
          taskId: task_id,
          until: until.toISOString(),
        })
        return success({ action: 'snooze2h', task_id, until: until.toISOString(), result })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    console.error('POST /api/notifications/actions error:', err)
    return handleError(err)
  }
}
