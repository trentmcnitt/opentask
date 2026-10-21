/**
 * Snooze operation
 *
 * Thin wrapper around updateTask that applies snooze-specific validation.
 * A snooze is a move of the target (§6, 2026-10-12 — there is no snooze
 * state): updateTask keeps the first-target date and caps the move at the
 * deadline (§8.2).
 */

import type { Task } from '@/types'
import { ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { isTracked } from '@/lib/track'
import { REMINDER_SNOOZE_MESSAGE } from '@/core/validation'
import { loadTaskForMutation } from './access'
import { updateTask } from './update'

export interface SnoozeTaskOptions {
  userId: number
  userTimezone: string
  taskId: number
  until: string // ISO 8601 datetime
}

export interface SnoozeResult {
  task: Task
  previousDueAt: string | null
  originalDueAt: string | null
  description: string | null
  /** §8.2: the snooze stopped AT the deadline instead of `until`. */
  cappedAtDeadline: boolean
}

/**
 * Snooze a task to a future time
 *
 * This is a thin wrapper around updateTask that:
 * 1. Validates snooze-specific preconditions (not done, not trashed)
 * 2. Delegates to updateTask which handles snooze logic internally
 */
export function snoozeTask(options: SnoozeTaskOptions): SnoozeResult {
  const { userId, userTimezone, taskId, until } = options

  // Pre-validation (snooze-specific checks)
  // 'allow': the trashed refusal comes later, after the reminder/quota/done
  // refusals it has always followed.
  const task = loadTaskForMutation(userId, taskId, { trashed: 'allow' })

  // Validate snooze target is a valid datetime
  const snoozeTarget = new Date(until)
  if (isNaN(snoozeTarget.getTime())) {
    throw new ValidationError('Invalid defer target datetime')
  }
  // Note: We allow snoozing to past times - the task will just appear overdue immediately.
  // This lets users adjust due dates freely using the increment/decrement controls.

  // §6: reminders cannot be snoozed out of their time slot. They stay visible
  // in the slot until completed — completion means "considered", which is the
  // whole interaction. Allowing a snooze would reintroduce exactly the
  // defensive re-dating this redesign removes, on the one population that has
  // no debt to defer.
  if (task.is_reminder) {
    throw new ValidationError(REMINDER_SNOOZE_MESSAGE)
  }

  // §5: a quota cannot be snoozed either, for the stronger reason that it has
  // no due date to move (QUOTA_DUE_DATE_MESSAGE). "Four times this week" is a
  // count over a period, not an appointment to defer. `collectFieldChanges`
  // would refuse the underlying PATCH anyway; checking here names the
  // operation the caller actually asked for. Bulk snooze skips quotas rather
  // than failing the sweep (see `bulkSnooze`).
  if (isTracked(task)) {
    throw new ValidationError(
      'Quotas cannot be deferred — a quota is counted within its period, not due on a day',
    )
  }

  // Only active tasks can be snoozed (SN-005)
  if (task.done) {
    throw new ValidationError('Cannot defer done task')
  }
  if (task.deleted_at) {
    throw new ValidationError('Cannot defer trashed task')
  }

  const previousDueAt = task.due_at

  // Delegate to updateTask - it handles snooze logic internally.
  // Pass pre-fetched task to avoid redundant DB lookup (we already validated access above).
  const {
    task: updatedTask,
    description,
    cappedAtDeadline,
  } = updateTask({
    userId,
    userTimezone,
    taskId,
    input: { due_at: until },
    prefetchedTask: task,
    skipWebhookDispatch: true, // snoozeTask dispatches task.snoozed below
  })

  dispatchWebhookEvent(userId, 'task.snoozed', {
    task: formatTaskResponse(updatedTask, userTimezone),
    previous_due_at: previousDueAt,
  })

  return {
    task: updatedTask,
    previousDueAt,
    originalDueAt: updatedTask.original_due_at,
    description,
    cappedAtDeadline: cappedAtDeadline === true,
  }
}
