/**
 * Bulk Snooze API route
 *
 * POST /api/tasks/bulk/snooze - Snooze multiple tasks
 *
 * Body (absolute mode): { ids: [1, 2, 3, ...], until: "ISO8601 datetime" }
 * Body (relative mode): { ids: [1, 2, 3, ...], delta_minutes: 60 }
 * Optional `source`: 'sweep' (Snooze-all) or 'try_tomorrow' — a DEFER under the
 * task queue (docs/TASK-MODEL.md § Picks and defers); absent = a pick.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { taskQueueFields } from '@/core/tasks/bulk'
import { validateBulkSnooze } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'
import { requestUndoId } from '@/core/request-context'

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
      includeTaskIds: input.include_task_ids,
      // Pick (absent) or defer (task queue): passed straight through.
      source: input.source,
      // `allow_past_deadline_ids` / `cap_at_deadline_ids` are accepted and
      // ignored (2026-10-12): every move stops at its deadline (§8.2).
    })

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
      skipped_no_due_date: result.noDueDateSkipped,
      // Held back like High (Trent's ruling, 2026-10-12): below High by
      // priority, but the deadline has passed, so swept only once nothing
      // lower is left. Not in `skipped_urgent`.
      skipped_deadline: result.deadlineSkipped,
      // Snoozed only as far as a deadline still ahead (§8.2).
      capped_deadline: result.deadlineCapped,
      ...taskQueueFields(result),
      // The ids this call actually moved (2026-10-26), queued ones included:
      // a client clears exactly these tasks' banners, nothing else.
      moved_ids: result.snoozedIds,
      undo_id: requestUndoId(),
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
