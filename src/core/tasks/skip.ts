/**
 * Skip an occurrence (REDESIGN-V03 §7.5)
 *
 * "Not doing this occurrence — advance without recording a completion."
 *
 * WHY THIS EXISTS: today the user has exactly two ways to clear an item, and
 * both corrupt the record. Marking it done is a lie that inflates
 * `completion_count`; snoozing is a deferral that re-dates something they have
 * actually decided not to do. Skip protects `completion_count`'s honesty, which
 * matters because adherence history is the one signal the app can trust (L1 —
 * the only trustworthy adherence signal is an explicit completion).
 *
 * NAMING (§6.0 terminology guard): the API action is `skip-occurrence`, not
 * `skip`. `review/execute` already uses "skip" for a no-op review
 * acknowledgment — a different operation entirely.
 *
 * NOTHING MAY BE BUILT ON SKIP PATTERNS. Bulk-skipping is expected, and per L1
 * a clearing gesture carries no information about intent. `skip_count` exists so
 * that completions stay honest, NOT so anyone can infer avoidance from it.
 */

import { withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { nowUtc, computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { emitSyncEvent } from '@/lib/sync-events'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import type { Task } from '@/types'

export interface SkipOccurrenceOptions {
  userId: number
  userTimezone: string
  taskId: number
}

export interface SkipOccurrenceResult {
  task: Task
  wasRecurring: boolean
  description: string
}

/**
 * Skip one occurrence.
 *
 * Recurring: advance `due_at` to the next occurrence, leaving
 * `completion_count` untouched and incrementing `skip_count`.
 *
 * One-off: equivalent to archiving without completion — the task leaves the
 * active list but is never recorded as done.
 */
export function skipOccurrence(options: SkipOccurrenceOptions): SkipOccurrenceResult {
  const { userId, userTimezone, taskId } = options

  const task = getTaskById(taskId)
  if (!task) throw new NotFoundError('Task not found')
  if (!canUserAccessTask(userId, task)) throw new ForbiddenError('Access denied')
  if (task.deleted_at) throw new ValidationError('Cannot skip a trashed task')
  if (task.done && !isRecurring(task.rrule)) {
    throw new ValidationError('Task is already done')
  }

  const nowStr = nowUtc()
  const skipCount = (task.skip_count ?? 0) + 1
  const recurring = isRecurring(task.rrule)

  const result = withTransaction((tx) => {
    let after: Task
    let fieldsChanged: string[]

    if (recurring) {
      const nextOccurrence = computeNextOccurrence({
        rrule: task.rrule!,
        recurrenceMode: task.recurrence_mode,
        anchorTime: task.anchor_time,
        timezone: userTimezone,
        completedAt: new Date(),
        prevDueAt: task.due_at ? new Date(task.due_at) : null,
      })
      const nextDueAt = nextOccurrence.toISOString()

      // §5: advancing the occurrence is a period boundary, so a tracked task's
      // progress resets here exactly as it would on completion.
      tx.prepare(
        `UPDATE tasks
            SET due_at = ?, original_due_at = ?, skip_count = ?, progress_current = 0,
                updated_at = ?
          WHERE id = ?`,
      ).run(nextDueAt, nextDueAt, skipCount, nowStr, taskId)

      after = {
        ...task,
        due_at: nextDueAt,
        original_due_at: nextDueAt,
        skip_count: skipCount,
        progress_current: 0,
      }
      fieldsChanged = ['due_at', 'original_due_at', 'skip_count', 'progress_current']
    } else {
      // Archived, never completed. done stays 0 — that is the entire point.
      tx.prepare(
        `UPDATE tasks SET archived_at = ?, skip_count = ?, updated_at = ? WHERE id = ?`,
      ).run(nowStr, skipCount, nowStr, taskId)

      after = { ...task, archived_at: nowStr, skip_count: skipCount }
      fieldsChanged = ['archived_at', 'skip_count']
    }

    logAction(userId, 'skip', `Skipped "${task.title}"`, fieldsChanged, [
      createTaskSnapshot(task, after, fieldsChanged),
    ])

    logActivity({
      userId,
      taskId,
      action: 'skip',
      fields: fieldsChanged,
      before: { id: taskId, due_at: task.due_at, skip_count: task.skip_count },
      after: { id: taskId, due_at: after.due_at, skip_count: skipCount },
      metadata: { recurring },
    })

    return after
  })

  emitSyncEvent(userId)

  // §7.5: a skip is NOT a completion. Anything downstream that counts
  // completions must never see this as one.
  dispatchWebhookEvent(userId, 'task.skipped', { task: formatTaskResponse(result) })

  return {
    task: result,
    wasRecurring: recurring,
    description: recurring ? `Skipped "${task.title}"` : `Skipped and archived "${task.title}"`,
  }
}
