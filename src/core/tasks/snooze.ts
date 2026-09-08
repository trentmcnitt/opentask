/**
 * Snooze operation
 *
 * Thin wrapper around updateTask that applies snooze-specific validation.
 * The actual snooze logic (original_due_at tracking, snooze_count increment)
 * is handled by updateTask when due_at changes without rrule change.
 */

import type { Task } from '@/types'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { isTracked } from '@/lib/track'
import { getTaskById } from './create'
import { canUserAccessTask, updateTask } from './update'

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
  const task = getTaskById(taskId)
  if (!task) {
    throw new NotFoundError('Task not found')
  }

  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  // Validate snooze target is a valid datetime
  const snoozeTarget = new Date(until)
  if (isNaN(snoozeTarget.getTime())) {
    throw new ValidationError('Invalid snooze target datetime')
  }
  // Note: We allow snoozing to past times - the task will just appear overdue immediately.
  // This lets users adjust due dates freely using the increment/decrement controls.

  // §6: reminders cannot be snoozed out of their time slot. They stay visible
  // in the slot until completed — completion means "considered", which is the
  // whole interaction. Allowing a snooze would reintroduce exactly the
  // defensive re-dating this redesign removes, on the one population that has
  // no debt to defer.
  if (task.is_reminder) {
    throw new ValidationError(
      'Reminders cannot be snoozed — they stay in their time slot until completed',
    )
  }

  // §5: a quota cannot be snoozed either, for the stronger reason that it has
  // no due date to move (QUOTA_DUE_DATE_MESSAGE). "Four times this week" is a
  // count over a period, not an appointment to defer. `collectFieldChanges`
  // would refuse the underlying PATCH anyway; checking here names the
  // operation the caller actually asked for. Bulk snooze skips quotas rather
  // than failing the sweep (see `bulkSnooze`).
  if (isTracked(task)) {
    throw new ValidationError(
      'Quotas cannot be snoozed — a quota is counted within its period, not due on a day',
    )
  }

  // Only active tasks can be snoozed (SN-005)
  if (task.done) {
    throw new ValidationError('Cannot snooze done task')
  }
  if (task.deleted_at) {
    throw new ValidationError('Cannot snooze trashed task')
  }

  const previousDueAt = task.due_at

  // Delegate to updateTask - it handles snooze logic internally.
  // Pass pre-fetched task to avoid redundant DB lookup (we already validated access above).
  const { task: updatedTask, description } = updateTask({
    userId,
    userTimezone,
    taskId,
    input: { due_at: until },
    prefetchedTask: task,
    skipWebhookDispatch: true, // snoozeTask dispatches task.snoozed below
  })

  dispatchWebhookEvent(userId, 'task.snoozed', {
    task: formatTaskResponse(updatedTask),
    previous_due_at: previousDueAt,
  })

  return {
    task: updatedTask,
    previousDueAt,
    originalDueAt: updatedTask.original_due_at,
    description,
  }
}
