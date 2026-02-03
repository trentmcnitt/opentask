/**
 * Snooze operation
 *
 * First-class snooze with snoozed_from tracking.
 * - First snooze: saves original due_at to snoozed_from
 * - Re-snooze: preserves original snoozed_from
 */

import { withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'

export interface SnoozeTaskOptions {
  userId: number
  taskId: number
  until: string // ISO 8601 datetime
}

export interface SnoozeResult {
  task: Task
  previousDueAt: string | null
  snoozedFrom: string | null
}

/**
 * Snooze a task to a future time
 *
 * - First snooze: saves original due_at to snoozed_from
 * - Re-snooze: preserves existing snoozed_from (the original)
 */
export function snoozeTask(options: SnoozeTaskOptions): SnoozeResult {
  const { userId, taskId, until } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Validate snooze target is a valid datetime
  const snoozeTarget = new Date(until)
  if (isNaN(snoozeTarget.getTime())) {
    throw new Error('Invalid snooze target datetime')
  }
  // Note: We allow snoozing to past times - the task will just appear overdue immediately.
  // This lets users adjust due dates freely using the increment/decrement controls.

  // Only active tasks can be snoozed (SN-005)
  if (task.done) {
    throw new Error('Cannot snooze done task')
  }
  if (task.deleted_at) {
    throw new Error('Cannot snooze trashed task')
  }

  const nowStr = nowUtc()
  const previousDueAt = task.due_at

  // Determine snoozed_from value:
  // - First snooze (snoozed_from is NULL): save current due_at to snoozed_from
  // - Re-snooze (snoozed_from already set): keep existing snoozed_from
  const newSnoozedFrom = task.snoozed_from ?? task.due_at

  // Execute snooze and undo log in a transaction
  return withTransaction((db) => {
    // Update task
    db.prepare(
      `
      UPDATE tasks
      SET due_at = ?, snoozed_from = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(until, newSnoozedFrom, nowStr, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, due_at: task.due_at, snoozed_from: task.snoozed_from },
      { id: taskId, due_at: until, snoozed_from: newSnoozedFrom },
      ['due_at', 'snoozed_from'],
    )
    logAction(userId, 'snooze', `Snoozed "${task.title}"`, ['due_at', 'snoozed_from'], [snapshot])

    // Return updated task
    const updatedTask = getTaskById(taskId)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return {
      task: updatedTask,
      previousDueAt,
      snoozedFrom: newSnoozedFrom,
    }
  })
}

/**
 * Clear snooze from a task (restore original due_at)
 */
export function clearSnooze(options: { userId: number; taskId: number }): Task {
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

  // Must be snoozed
  if (!task.snoozed_from) {
    throw new Error('Task is not snoozed')
  }

  const nowStr = nowUtc()
  const originalDueAt = task.snoozed_from

  // Execute update and undo log in a transaction
  return withTransaction((tx) => {
    // Restore original due_at, clear snoozed_from
    tx.prepare(
      `
      UPDATE tasks
      SET due_at = ?, snoozed_from = NULL, updated_at = ?
      WHERE id = ?
    `,
    ).run(originalDueAt, nowStr, taskId)

    // Log to undo (this is like a reverse snooze)
    const snapshot = createTaskSnapshot(
      { id: taskId, due_at: task.due_at, snoozed_from: task.snoozed_from },
      { id: taskId, due_at: originalDueAt, snoozed_from: null },
      ['due_at', 'snoozed_from'],
    )
    logAction(
      userId,
      'snooze',
      `Cleared snooze on "${task.title}"`,
      ['due_at', 'snoozed_from'],
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
