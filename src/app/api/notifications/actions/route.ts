/**
 * Notification action callbacks
 *
 * POST /api/notifications/actions - Handle notification action callbacks (done, snooze, delete)
 *
 * Body: { action: "done" | "snooze" | "snooze30" | "snooze2h" | "delete", task_id: number, token: string }
 *
 * `delete` is the "AI finished" notification's Delete button (category
 * `TASK_ADDED`, see `buildEnrichedNotification` in `apns.ts`): a just-added
 * task the user doesn't want. It is the same soft delete as the app's Delete
 * (`deleteTask`) — to the trash, undo-logged, notifications dismissed, open
 * tabs and widgets synced — so Undo in the app brings it back.
 *
 * Auth: Token is passed in the request body (not the Authorization header) because iOS
 * Notification Content Extensions cannot set custom HTTP headers. The extension reads
 * the token from the shared Keychain (App Group) and includes it in the JSON body.
 */

import { NextRequest } from 'next/server'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { validateBearerToken } from '@/core/auth/bearer'
import { markDone, snoozeTask, deleteTask } from '@/core/tasks'
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

    // markDone, snoozeTask and deleteTask dismiss the task's notification on every device
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

      case 'delete': {
        // `{ task }`, the shape done and snooze return (deleteTask returns the
        // bare task), so a client reads `result.task` for every action.
        const task = deleteTask({ userId: user.id, taskId: task_id })
        log.info('notifications', `Action complete: delete on task ${task_id}`)
        return success({ action: 'delete', task_id, result: { task } })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('api', 'POST /api/notifications/actions error:', err)
    return handleError(err)
  }
})
