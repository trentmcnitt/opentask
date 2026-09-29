/**
 * Track / quotas (REDESIGN-V03 §5)
 *
 * Every task is already a quota with target 1. Track generalises completion:
 * `progress_target` is how many times something should happen in a period, and
 * `progress_current` is how many have been logged.
 *
 * AT-TARGET BEHAVIOR IS PERIOD-ANCHORED (decided by Trent, 2026-07-26).
 * Reaching the target marks the row "met" — a visual state change, no completion
 * event. The row stays OPEN until its period ends, and the period-rollover cron
 * (`period-rollover.ts`) is what closes it: it records the period in
 * `progress_periods`, writes a completion if the target was met, and resets
 * `progress_current` to 0. Overflow is therefore observable: a third egg meal in
 * a 2x/week target displays as 3/2 rather than vanishing.
 *
 * The rejected alternative was auto-completing at target, which made overflow
 * unobservable — the row disappeared at 2/2 and the third never got recorded.
 *
 * The one other way a period ends is `close_period`, an API-only early close:
 * `markDone`/`bulkDone` refuse a quota unless the caller passes
 * `close_period: true` (2026-09-24). That runs the ordinary recurring
 * completion path (`execute-mark-done.ts`) — a completions row and the count
 * reset to 0 — but writes NO `progress_periods` row and does not move the
 * period anchor. No app surface offers it — every quota surface only logs
 * progress — and an API `done` on a quota almost always meant +1, which the
 * old behavior answered by silently zeroing the period's count.
 *
 * WHAT MUST NOT HAPPEN HERE:
 * - A sub-target increment must NOT dispatch `task.completed`. Anything
 *   downstream counting completions would over-count by the target.
 * - Tracked items are EXEMPT from the §4.1 notification cadence (see the
 *   `progress_target > 1` exclusion in overdue-checker). Without that exemption
 *   a tracked task with a due date gets the standard nag PLUS the pace nudge.
 * - Pace is deterministic view logic, never AI, and never a failure state.
 *   Per §1.2 the app is an instrument: it keeps the score it was asked to keep
 *   and shuts up otherwise.
 */

import { getDb, withTransaction } from '@/core/db'
import { logAction, createQuotaSnapshot } from '@/core/undo'
import { nowUtc } from '@/core/recurrence'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import { rolloverQuotaNow } from './period-rollover'
import { localDate, withLogged } from '@/lib/quota-prompts'
// ONE definition of "is this a quota" — the client-safe one in lib/track. This
// file used to carry its own copy, and two copies of a rule this central are
// how the reminder/quota guard in updateTask ended up testing only half of it.
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'
import { emitSyncEvent } from '@/lib/sync-events'

export interface IncrementProgressOptions {
  userId: number
  taskId: number
  /** Defaults to +1. Negative values correct a mis-log. */
  delta?: number
}

export interface IncrementProgressResult {
  task: Task
  /** True when this increment brought the task to or past its target. */
  met: boolean
  description: string
}

/**
 * Record progress on a tracked task.
 *
 * Deliberately does NOT complete the task at target — see the period-anchored
 * decision above. It dispatches `task.progressed`, never `task.completed`.
 */
export function incrementProgress(options: IncrementProgressOptions): IncrementProgressResult {
  const { userId, taskId, delta = 1 } = options

  const found = getTaskById(taskId)
  if (!found) throw new NotFoundError('Task not found')
  if (!canUserAccessTask(userId, found)) throw new ForbiddenError('Access denied')
  if (found.deleted_at) throw new ValidationError('Cannot log progress on a trashed task')
  if (!isTracked(found)) {
    throw new ValidationError(
      'Task is not tracked. Set a progress_target greater than 1 to track it.',
    )
  }

  const nowStr = nowUtc()

  const { updated, next, task } = withTransaction((tx) => {
    // Close an expired period FIRST, in this transaction, so a +1 at 00:02
    // lands in today's period rather than being recorded as yesterday's and
    // zeroed by the cron three minutes later. See `rolloverQuotaNow`.
    rolloverQuotaNow(taskId)
    const task = getTaskById(taskId) ?? found

    // Progress never goes below zero — a correction can undo a mis-log but can't
    // manufacture negative history.
    const current = task.progress_current ?? 0
    const next = Math.max(0, current + delta)
    // What actually changed. A −1 at zero changes nothing, and progress_events
    // is a history of what was logged, so it records this rather than the
    // request — a clamped −1 used to be written as −1 against a count that
    // never moved.
    const applied = next - current

    // Quota reminders: progress logged today from ANYWHERE clears a weekly or
    // monthly quota's prompt for the day, and a −1 that takes back a "did it"
    // brings that prompt back as waiting (`withLogged`). It is recorded here,
    // in the same write, so undoing the +1 brings the prompt back. The owner's day, since
    // prompts are the owner's (a shared quota is never prompted to others).
    const dayState = withLogged(
      task.quota_day_state,
      localDate(ownerTimezone(task.user_id)),
      applied,
      next,
    )

    tx.prepare(
      'UPDATE tasks SET progress_current = ?, quota_day_state = ?, updated_at = ? WHERE id = ?',
    ).run(next, JSON.stringify(dayState), nowStr, taskId)
    if (applied !== 0) {
      tx.prepare(
        'INSERT INTO progress_events (task_id, user_id, delta, logged_at) VALUES (?, ?, ?, ?)',
      ).run(taskId, userId, applied, nowStr)
    }

    // Logged even when nothing moved: a client offers Undo on its toast for
    // every tap, and an Undo with no entry of its own would undo whatever
    // came before it.
    const after = { ...task, progress_current: next, quota_day_state: dayState }
    const fields = ['progress_current', 'quota_day_state']
    logAction(
      userId,
      'progress',
      `Logged ${applied > 0 ? '+' : ''}${applied} on "${task.title}" (${next}/${task.progress_target})`,
      fields,
      [createQuotaSnapshot(task, after, fields)],
    )
    return { updated: after, next, task }
  })
  const met = next >= task.progress_target

  // Other tabs and the widgets learn about the new count the same way they
  // learn about every other mutation.
  emitSyncEvent(userId)

  // §5: progress is NOT completion. Firing task.completed here would make every
  // downstream counter over-count by the target.
  dispatchWebhookEvent(userId, 'task.progressed', {
    task: formatTaskResponse(updated),
    progress_current: next,
    progress_target: task.progress_target,
    met,
  })

  return {
    task: updated,
    met,
    description: `${next}/${task.progress_target}`,
  }
}

/** A user's timezone — a quota's day is its owner's day. */
export function ownerTimezone(userId: number): string {
  const row = getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
    | { timezone: string }
    | undefined
  return row?.timezone ?? 'UTC'
}
