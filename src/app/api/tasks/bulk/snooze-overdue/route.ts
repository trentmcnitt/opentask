/**
 * Bulk Snooze Overdue API route
 *
 * POST /api/tasks/bulk/snooze-overdue - Snooze all overdue tasks for the user
 *
 * Server-side convenience for the iOS "All" button — no task IDs needed from client.
 * Queries overdue tasks, applies priority filtering via bulkSnooze() (P0-P2 eligible,
 * P3 High and P4 Urgent excluded).
 *
 * Computes an absolute snooze target from now (not relative to each task's due_at):
 * - { delta_minutes: 30 }  → 30 min from now (exact, < 60 min)
 * - { delta_minutes: 60 }  → 1 hour from now, snapped to nearest hour
 * - { until: "ISO8601" }   → explicit absolute target
 * - { tomorrow: true }     → tomorrow at the user's morning_time
 * - {} (empty body)        → user's default_snooze_option preference
 *
 * Feedback push: when a Bearer-token caller's sweep leaves High or Urgent tasks
 * overdue, one quiet notification says so (`planSweepFeedback`, in
 * `src/core/notifications/sweep-feedback.ts`, has the rules; `notify: false`
 * suppresses it). `feedback_notification` in the response reports whether one
 * was sent for this call.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError, extractBearerToken } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { validateBulkSnoozeOverdue } from '@/core/validation'
import { bulkSnoozeMessage, computeSnoozeTime } from '@/lib/snooze'
import { nextPeriodStart, nextSlotStart } from '@/lib/time-slot-assign'
import { listTimeSlots } from '@/core/time-slots'
import { ValidationError } from '@/core/errors'
import { log } from '@/lib/logger'
import { getDb } from '@/core/db'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'
import { planSweepFeedback, sendSweepFeedback } from '@/core/notifications/sweep-feedback'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const input = validateBulkSnoozeOverdue(body)

    // Compute absolute snooze target from now
    let until: string
    if (input.slot) {
      // A time slot: resolved here, in the user's timezone, never on the
      // client (see `bulkSnoozeOverdueSchema`).
      const resolved =
        input.slot === 'next'
          ? nextPeriodStart(listTimeSlots(user.id), user.timezone)
          : nextSlotStart(input.slot, user.timezone)
      if (!resolved) throw new ValidationError('No time slots to snooze to')
      until = resolved
    } else if (input.until) {
      until = input.until
    } else {
      // `tomorrow`, else delta_minutes, else the user's default_snooze_option
      const db = getDb()
      const prefs = db
        .prepare('SELECT default_snooze_option, morning_time FROM users WHERE id = ?')
        .get(user.id) as { default_snooze_option: string; morning_time: string }

      const option = input.tomorrow
        ? 'tomorrow'
        : input.delta_minutes
          ? String(input.delta_minutes)
          : prefs.default_snooze_option

      until = computeSnoozeTime(option, user.timezone, prefs.morning_time)
    }

    // Which tasks are actually due now (§4.6). A recurring task's due_at
    // freezes once the daily sweep stops, so the old `due_at < now` SQL would
    // sweep items that aren't scheduled today — re-dating them and deepening
    // exactly the mess this redesign is unwinding.
    const dueNow = getCurrentlyDueTaskIds(user.id)
    const taskIds = [...dueNow]

    // Merge in explicitly included task IDs (e.g., the P4 task the user is acting on)
    const includeTaskIds = input.include_task_ids
    if (includeTaskIds?.length) {
      const existing = new Set(taskIds)
      for (const id of includeTaskIds) {
        if (!existing.has(id)) {
          taskIds.push(id)
        }
      }
    }

    if (taskIds.length === 0) {
      return success({
        tasks_affected: 0,
        tasks_skipped: 0,
        skipped_urgent: 0,
        skipped_high: 0,
        snoozed_high: 0,
        skipped_reminders: 0,
        until,
        message: bulkSnoozeMessage({ affected: 0, high: 0, urgent: 0 }),
        feedback_notification: false,
      })
    }

    // bulkSnooze handles priority filtering internally: P0-P2 always, P3 (High)
    // once nothing lower is left in the batch, P4 never — unless explicitly
    // included via includeTaskIds. See `filterForBulkSnooze`.
    //
    // It also dismisses the moved tasks' notifications. `dueBeforeIds` hands it
    // the due set measured above, so the badge count after the sweep comes
    // from arithmetic instead of another rrule walk (`stillDueAfterSnooze`).
    const result = bulkSnooze({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds,
      until,
      includeTaskIds,
      dueBeforeIds: dueNow,
    })

    // The feedback push (sweep-feedback.ts): decided here, after the sweep
    // committed, and sent without awaiting so the response isn't held up.
    // `requireAuth` succeeded, so a Bearer header here is a valid token. The
    // overdue count left follows from arithmetic, as in `stillDueAfterSnooze`.
    const snoozed = new Set(result.snoozedIds)
    const feedback = planSweepFeedback(user.id, {
      viaBearer: extractBearerToken(request.headers.get('Authorization')) !== null,
      notify: input.notify,
      counts: {
        affected: result.tasksAffected,
        highAffected: result.highSnoozed,
        high: result.highSkipped,
        urgent: result.urgentSkipped - result.highSkipped,
      },
      until,
      timezone: user.timezone,
      totalOverdueCount: dueNow.filter((id) => !snoozed.has(id)).length,
    })
    if (feedback) void sendSweepFeedback(user.id, feedback)

    notifyDemoEngagement(user.name, 'update')
    return success({
      tasks_affected: result.tasksAffected,
      tasks_skipped: result.tasksSkipped,
      skipped_urgent: result.urgentSkipped,
      // The High subset of `skipped_urgent`, so a client can name High and
      // Urgent accurately. Additive: `skipped_urgent` keeps its old meaning of
      // "skipped on priority" for the clients that already read it.
      skipped_high: result.highSkipped,
      // How many of the moved tasks were High — all of them on the second press
      // of a double snooze, which the toast names (see `bulkSnoozeMessage`).
      snoozed_high: result.highSnoozed,
      // §6: reminders are bucket-locked, so a sweep reports them rather than
      // prompting about them.
      skipped_reminders: result.reminderSkipped,
      // The resolved target (ISO), so a client can say where things went.
      until,
      // Ready-to-display summary for clients that can't branch on the counts
      // (Apple Shortcuts show `data.message` as-is). Same copy as the web
      // toast (`useSnoozeOverdue`): `skipped_urgent` counts High AND Urgent, so
      // Urgent alone is the difference.
      message: bulkSnoozeMessage({
        affected: result.tasksAffected,
        highAffected: result.highSnoozed,
        high: result.highSkipped,
        urgent: result.urgentSkipped - result.highSkipped,
      }),
      // Whether this call sent the feedback push — so a Shortcut can show
      // `message` only when no notification is coming.
      feedback_notification: feedback !== null,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks/bulk/snooze-overdue error:', err)
    return handleError(err)
  }
})
