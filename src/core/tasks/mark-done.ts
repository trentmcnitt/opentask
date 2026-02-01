/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, UndoSnapshot } from '@/types'
import { nowUtc, computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
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
  const db = getDb()

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
    return markOneOffDone(task, userId, nowStr)
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
  nowStr: string
): MarkDoneResult {
  const db = getDb()

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

  return withTransaction((tx) => {
    // Create completion record
    const completionResult = tx
      .prepare(
        `
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(task.id, userId, nowStr, prevDueAt, nextDueAt)

    const completionId = Number(completionResult.lastInsertRowid)

    // Update task: advance due_at, clear snoozed_from
    tx.prepare(
      `
      UPDATE tasks
      SET due_at = ?, snoozed_from = NULL, updated_at = ?
      WHERE id = ?
    `
    ).run(nextDueAt, nowStr, task.id)

    // Build snapshot with completion data for redo
    const afterState: Partial<Task> & { _completion?: unknown } = {
      id: task.id,
      due_at: nextDueAt,
      snoozed_from: null,
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
      },
      after_state: afterState,
      completion_id: completionId,
    }

    // Log to undo
    logAction(userId, 'done', `Marked "${task.title}" done`, ['due_at', 'snoozed_from'], [snapshot])

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
function markOneOffDone(task: Task, userId: number, nowStr: string): MarkDoneResult {
  return withTransaction((tx) => {
    // Update task: set done=1, done_at, archived_at
    tx.prepare(
      `
      UPDATE tasks
      SET done = 1, done_at = ?, archived_at = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(nowStr, nowStr, nowStr, task.id)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: task.id, done: false, done_at: null, archived_at: null },
      { id: task.id, done: true, done_at: nowStr, archived_at: nowStr },
      ['done', 'done_at', 'archived_at']
    )
    logAction(userId, 'done', `Marked "${task.title}" done`, ['done', 'done_at', 'archived_at'], [snapshot])

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
    `
    ).run(nowStr, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, done: true, done_at: task.done_at, archived_at: task.archived_at },
      { id: taskId, done: false, done_at: null, archived_at: null },
      ['done', 'done_at', 'archived_at']
    )
    logAction(userId, 'undone', `Reopened "${task.title}"`, ['done', 'done_at', 'archived_at'], [snapshot])

    // Return updated task
    const updatedTask = getTaskById(taskId)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return updatedTask
  })
}
