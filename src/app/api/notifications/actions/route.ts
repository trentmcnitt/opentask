/**
 * Notification action callbacks
 *
 * POST /api/notifications/actions - Handle notification action callbacks (done, snooze, delete)
 *
 * Body: { action: "done" | "snooze" | "snooze30" | "snooze2h" | "delete", task_id: number,
 *         token?: string, day?: "yyyy-MM-dd" }
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
 * A body token that is present but invalid is a 401, never a fall-through. With NO
 * body token (2026-10-26) the request is authenticated like any other route —
 * Bearer header, proxy header, then the session cookie — so the service worker's
 * "Considered" button (public/sw.js) can call this with the cookie alone. A
 * cookie-authenticated request must also be same-origin (CSRF; 403 otherwise).
 *
 * `day` (2026-10-26, the named reminder push's "Considered" button): the OpenTask
 * date the push was waiting on (`reminder_day`). With it, `done` only considers a
 * reminder that is waiting in the user's CURRENT day's roster; another day's push,
 * or a task not waiting there (considered elsewhere, not a reminder), answers 200
 * `{ considered: false }` and changes nothing — a stale push never advances an
 * occurrence (`reminderWaitingOn`). Without `day` (every other button, and native
 * builds before PR 3) `done` is unchanged. The other actions ignore it.
 */

import { sendDeadlineCapFeedback } from '@/core/notifications/deadline-cap-feedback'
import { NextRequest } from 'next/server'
import { success, unauthorized, badRequest, forbidden, handleError } from '@/lib/api-response'
import { validateBearerToken } from '@/core/auth/bearer'
import { getAuthUser } from '@/core/auth'
import { isCrossSiteCookieRequest } from '@/core/auth/same-origin'
import { reminderWaitingOn } from '@/core/notifications/reminder-nags'
import { markDone, snoozeTask, deleteTask } from '@/core/tasks'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { log } from '@/lib/logger'
import { computeSnoozeTime } from '@/lib/snooze'
import { withLogging } from '@/lib/with-logging'
import type { AuthUser } from '@/types'
import { requestUndoId } from '@/core/request-context'

/**
 * Snooze length in minutes per notification action. `computeSnoozeTime` (the
 * same helper as the app's snooze buttons) makes 30 exact minutes from now and
 * snaps the hour-based ones to the top of the hour.
 */
const SNOOZE_MINUTES: Record<string, number> = { snooze30: 30, snooze: 60, snooze2h: 120 }

/**
 * The caller. A body token when one is sent (the notification extension
 * can't set headers) — present but bad is a 401, never a fall-through; with
 * none, the ordinary chain (Bearer header, proxy, the service worker's
 * session cookie). Returns the 401 response when there is no user.
 *
 * CSRF: a request authenticated by the session cookie or the proxy header
 * (both ride an ambient browser cookie; only a token is exempt) must also be
 * same-origin (`isCrossSiteCookieRequest`: `Sec-Fetch-Site: same-origin` or
 * a matching `Origin`), else 403. The cookie is SameSite=Lax already; this is
 * the second wall.
 */
async function actionUser(request: NextRequest, token: unknown): Promise<AuthUser | Response> {
  if (token !== undefined && token !== null) {
    const user = typeof token === 'string' && token ? validateBearerToken(token) : null
    return user ?? unauthorized('Invalid token')
  }
  const user = await getAuthUser(request)
  if (!user) return unauthorized('Token required')
  if (isCrossSiteCookieRequest(request)) {
    log.warn(
      'notifications',
      `Action refused: cookie- or proxy-authenticated request for user ${user.id} is not same-origin ` +
        `(Origin ${request.headers.get('origin') ?? 'none'}, ` +
        `Sec-Fetch-Site ${request.headers.get('sec-fetch-site') ?? 'none'})`,
    )
    return forbidden('Cross-site request refused')
  }
  return user
}

function isLocalDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * `done`. With `day` (a named reminder push's Considered button), only a
 * reminder waiting in the current day's roster is considered; anything else
 * answers `considered: false` and changes nothing.
 */
function doneAction(user: AuthUser, taskId: number, day: string | null): Response {
  if (day !== null && !reminderWaitingOn(user.id, user.timezone, taskId, day)) {
    log.info('notifications', `Action skipped: task ${taskId} is not waiting on ${day}`)
    return success({ action: 'done', task_id: taskId, considered: false, undo_id: null })
  }
  const result = markDone({ userId: user.id, taskId, userTimezone: user.timezone })
  log.info('notifications', `Action complete: done on task ${taskId}`)
  return success({
    action: 'done',
    task_id: taskId,
    ...(day !== null ? { considered: true } : {}),
    result,
    undo_id: requestUndoId(),
  })
}

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, task_id, token, day } = body

    const user = await actionUser(request, token)
    if (user instanceof Response) return user

    if (!task_id || typeof task_id !== 'number' || !Number.isInteger(task_id) || task_id <= 0) {
      return badRequest('task_id must be a positive integer')
    }
    if (day !== undefined && day !== null && !isLocalDate(day)) {
      return badRequest('day must be a date (yyyy-MM-dd)')
    }

    log.info('notifications', `Action received: ${action} on task ${task_id} by user ${user.id}`)

    // markDone, snoozeTask and deleteTask dismiss the task's notification on every device
    // themselves (fire-and-forget), so nothing more is needed here.
    switch (action) {
      case 'done':
        return doneAction(user, task_id, typeof day === 'string' ? day : null)

      case 'snooze30':
      case 'snooze':
      case 'snooze2h': {
        // Only the minute options are passed, so the morning time is unused.
        const until = computeSnoozeTime(
          String(SNOOZE_MINUTES[action]),
          user.timezone,
          '',
          dayBoundaryForUser(user.id),
        )
        const result = snoozeTask({
          userId: user.id,
          userTimezone: user.timezone,
          taskId: task_id,
          until,
          // Stops AT the deadline instead of passing it, like every move
          // (§8.2, 2026-10-12; ruling A3 first did it for these buttons).
        })
        log.info('notifications', `Action complete: ${action} on task ${task_id}`)
        // A3: `until` is where the task actually went — the deadline when the
        // snooze would have crossed it.
        const landed = result.cappedAtDeadline ? result.task.due_at! : until
        // The button runs in the background and shows nothing: say it in a
        // quiet push (deadline-cap-feedback.ts).
        if (result.cappedAtDeadline) void sendDeadlineCapFeedback(user.id, landed, user.timezone)
        return success({
          action,
          task_id,
          until: landed,
          capped_at_deadline: result.cappedAtDeadline,
          result,
          undo_id: requestUndoId(),
        })
      }

      case 'delete': {
        // `{ task }`, the shape done and snooze return (deleteTask returns the
        // bare task), so a client reads `result.task` for every action.
        const task = deleteTask({ userId: user.id, taskId: task_id })
        log.info('notifications', `Action complete: delete on task ${task_id}`)
        return success({ action: 'delete', task_id, result: { task }, undo_id: requestUndoId() })
      }

      default:
        return badRequest(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('api', 'POST /api/notifications/actions error:', err)
    return handleError(err)
  }
})
