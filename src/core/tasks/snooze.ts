/**
 * Snooze operation
 *
 * Thin wrapper around updateTask that applies snooze-specific validation.
 * The actual snooze logic (original_due_at tracking, snooze_count increment)
 * is handled by updateTask when due_at changes without rrule change.
 */

import type { Task } from '@/types'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
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
  })

  return {
    task: updatedTask,
    previousDueAt,
    originalDueAt: updatedTask.original_due_at,
    description,
  }
}
