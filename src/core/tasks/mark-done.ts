/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { withTransaction } from '@/core/db'
import type { Task, UndoSnapshot } from '@/types'
import { nowUtc, computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { incrementDailyStat } from '@/core/stats'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'

export interface MarkDoneOptions {
  userId: number
  userTimezone: string
  taskId: number
}

export interface MarkDoneResult {
  task: Task
  wasRecurring: boolean
  nextDueAt?: string | null
}

/**
 * Mark a task as done
 *
 * For recurring tasks: advances due_at to next occurrence, clears snoozed_from
 * For one-off tasks: sets done=1, archived_at=now
 */
export function markDone(options: MarkDoneOptions): MarkDoneResult {
  const { userId, userTimezone, taskId } = options
  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot mark trashed task done
  if (task.deleted_at) {
    throw new Error('Cannot mark trashed task done')
  }

  // Cannot mark already done one-off task done again
  if (task.done && !isRecurring(task.rrule)) {
    throw new Error('Task is already done')
  }

  const now = new Date()
  const nowStr = nowUtc()

  if (isRecurring(task.rrule)) {
    return markRecurringDone(task, userId, userTimezone, now, nowStr)
  } else {
    return markOneOffDone(task, userId, userTimezone, nowStr)
  }
}

/**
 * Mark a recurring task done - advance to next occurrence
 */
function markRecurringDone(
  task: Task,
  userId: number,
  userTimezone: string,
  completedAt: Date,
  nowStr: string,
): MarkDoneResult {
  // Compute next occurrence
  const nextOccurrence = computeNextOccurrence({
    rrule: task.rrule!,
    recurrenceMode: task.recurrence_mode,
    anchorTime: task.anchor_time,
    timezone: userTimezone,
    completedAt,
  })

  const nextDueAt = nextOccurrence.toISOString()
  const prevDueAt = task.due_at

  // Compute new stats values
  const newCompletionCount = task.completion_count + 1
  const newFirstCompletedAt = task.first_completed_at ?? nowStr
  const newLastCompletedAt = nowStr

  return withTransaction((tx) => {
    // Create completion record
    const completionResult = tx
      .prepare(
        `
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(task.id, userId, nowStr, prevDueAt, nextDueAt)

    const completionId = Number(completionResult.lastInsertRowid)

    // Update task: advance due_at, clear snoozed_from, update completion stats
    tx.prepare(
      `
      UPDATE tasks
      SET due_at = ?, snoozed_from = NULL,
          completion_count = ?, first_completed_at = ?, last_completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    ).run(nextDueAt, newCompletionCount, newFirstCompletedAt, newLastCompletedAt, nowStr, task.id)

    // Build snapshot with completion data for redo
    const afterState: Partial<Task> & { _completion?: unknown } = {
      id: task.id,
      due_at: nextDueAt,
      snoozed_from: null,
      completion_count: newCompletionCount,
      first_completed_at: newFirstCompletedAt,
      last_completed_at: newLastCompletedAt,
      _completion: {
        user_id: userId,
        completed_at: nowStr,
        due_at_was: prevDueAt,
        due_at_next: nextDueAt,
      },
    }

    const snapshot: UndoSnapshot = {
      task_id: task.id,
      before_state: {
        id: task.id,
        due_at: task.due_at,
        snoozed_from: task.snoozed_from,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
      },
      after_state: afterState,
      completion_id: completionId,
    }

    // Log to undo
    const fieldsChanged = [
      'due_at',
      'snoozed_from',
      'completion_count',
      'first_completed_at',
      'last_completed_at',
    ]
    logAction(userId, 'done', `Marked "${task.title}" done`, fieldsChanged, [snapshot])

    // Increment daily stats
    incrementDailyStat(userId, 'completions', userTimezone)

    // Return updated task
    const updatedTask = getTaskById(task.id)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return {
      task: updatedTask,
      wasRecurring: true,
      nextDueAt,
    }
  })
}

/**
 * Mark a one-off task done - set done=1 and archive
 */
function markOneOffDone(
  task: Task,
  userId: number,
  userTimezone: string,
  nowStr: string,
): MarkDoneResult {
  // Compute new stats values
  const newCompletionCount = task.completion_count + 1
  const newFirstCompletedAt = task.first_completed_at ?? nowStr
  const newLastCompletedAt = nowStr

  return withTransaction((tx) => {
    // Update task: set done=1, done_at, archived_at, update completion stats
    tx.prepare(
      `
      UPDATE tasks
      SET done = 1, done_at = ?, archived_at = ?,
          completion_count = ?, first_completed_at = ?, last_completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    ).run(
      nowStr,
      nowStr,
      newCompletionCount,
      newFirstCompletedAt,
      newLastCompletedAt,
      nowStr,
      task.id,
    )

    // Log to undo
    const snapshot = createTaskSnapshot(
      {
        id: task.id,
        done: false,
        done_at: null,
        archived_at: null,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
      },
      {
        id: task.id,
        done: true,
        done_at: nowStr,
        archived_at: nowStr,
        completion_count: newCompletionCount,
        first_completed_at: newFirstCompletedAt,
        last_completed_at: newLastCompletedAt,
      },
      [
        'done',
        'done_at',
        'archived_at',
        'completion_count',
        'first_completed_at',
        'last_completed_at',
      ],
    )
    logAction(
      userId,
      'done',
      `Marked "${task.title}" done`,
      [
        'done',
        'done_at',
        'archived_at',
        'completion_count',
        'first_completed_at',
        'last_completed_at',
      ],
      [snapshot],
    )

    // Increment daily stats
    incrementDailyStat(userId, 'completions', userTimezone)

    // Return updated task
    const updatedTask = getTaskById(task.id)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return {
      task: updatedTask,
      wasRecurring: false,
    }
  })
}

/**
 * Mark a one-off task as undone (reopen)
 *
 * Only works for one-off tasks that are done.
 * For recurring tasks, use undo instead.
 */
export function markUndone(options: MarkDoneOptions): Task {
  const { userId, taskId } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot undone a recurring task (use undo instead)
  if (isRecurring(task.rrule)) {
    throw new Error('Cannot mark recurring task undone - use undo instead')
  }

  // Must be done
  if (!task.done) {
    throw new Error('Task is not done')
  }

  const nowStr = nowUtc()

  // Execute update and undo log in a transaction
  return withTransaction((tx) => {
    // Update task: clear done, done_at, archived_at
    tx.prepare(
      `
      UPDATE tasks
      SET done = 0, done_at = NULL, archived_at = NULL, updated_at = ?
      WHERE id = ?
    `,
    ).run(nowStr, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, done: true, done_at: task.done_at, archived_at: task.archived_at },
      { id: taskId, done: false, done_at: null, archived_at: null },
      ['done', 'done_at', 'archived_at'],
    )
    logAction(
      userId,
      'undone',
      `Reopened "${task.title}"`,
      ['done', 'done_at', 'archived_at'],
      [snapshot],
    )

    // Return updated task
    const updatedTask = getTaskById(taskId)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return updatedTask
  })
}
