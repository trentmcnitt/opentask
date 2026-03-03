/**
 * Execution helper for mark-done operations
 *
 * Performs the database operations for marking a task done within
 * a transaction. Used by both single and bulk mark-done operations.
 */

import type { Database } from 'better-sqlite3'
import type { Task, UndoSnapshot } from '@/types'
import type { MarkDoneComputation } from './compute-mark-done'

export interface ExecuteMarkDoneResult {
  snapshot: UndoSnapshot
  completionId?: number
}

/**
 * Execute the database operations for marking a task done
 *
 * Must be called within a transaction. Creates completion records
 * and updates task state.
 *
 * @param tx - Database transaction handle
 * @param task - The task being marked done
 * @param computation - Pre-computed state changes from computeMarkDone()
 * @param userId - User performing the action
 * @param nowStr - Current timestamp as ISO string
 * @returns Snapshot for undo and completionId
 */
export function executeMarkDone(
  tx: Database,
  task: Task,
  computation: MarkDoneComputation,
  userId: number,
  nowStr: string,
): ExecuteMarkDoneResult {
  if (computation.type === 'recurring') {
    return executeRecurringMarkDone(tx, task, computation, userId, nowStr)
  } else {
    return executeOneOffMarkDone(tx, task, computation, userId, nowStr)
  }
}

function executeRecurringMarkDone(
  tx: Database,
  task: Task,
  computation: Extract<MarkDoneComputation, { type: 'recurring' }>,
  userId: number,
  nowStr: string,
): ExecuteMarkDoneResult {
  const { nextDueAt, prevDueAt, stats } = computation

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

  // Update task: advance due_at, set original_due_at to new occurrence origin, update completion stats
  tx.prepare(
    `
    UPDATE tasks
    SET due_at = ?, original_due_at = ?,
        completion_count = ?, first_completed_at = ?, last_completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextDueAt,
    nextDueAt, // original_due_at tracks the new occurrence's origin timestamp
    stats.completionCount,
    stats.firstCompletedAt,
    stats.lastCompletedAt,
    nowStr,
    task.id,
  )

  // Build snapshot with completion data for redo
  const afterState: Partial<Task> & { _completion?: unknown } = {
    id: task.id,
    due_at: nextDueAt,
    original_due_at: nextDueAt,
    completion_count: stats.completionCount,
    first_completed_at: stats.firstCompletedAt,
    last_completed_at: stats.lastCompletedAt,
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
      title: task.title,
      due_at: task.due_at,
      original_due_at: task.original_due_at,
      completion_count: task.completion_count,
      first_completed_at: task.first_completed_at,
      last_completed_at: task.last_completed_at,
    },
    after_state: afterState,
    completion_id: completionId,
  }

  return { snapshot, completionId }
}

function executeOneOffMarkDone(
  tx: Database,
  task: Task,
  computation: Extract<MarkDoneComputation, { type: 'one_off' }>,
  userId: number,
  nowStr: string,
): ExecuteMarkDoneResult {
  const { stats } = computation

  // Create completion record (same as recurring tasks, but with no next occurrence)
  const completionResult = tx
    .prepare(
      `
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
      VALUES (?, ?, ?, ?, NULL)
    `,
    )
    .run(task.id, userId, nowStr, task.due_at)

  const completionId = Number(completionResult.lastInsertRowid)

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
    stats.completionCount,
    stats.firstCompletedAt,
    stats.lastCompletedAt,
    nowStr,
    task.id,
  )

  // Build snapshot manually (like recurring path) to include _completion data
  // for redo. createTaskSnapshot would strip _completion since it's not in
  // fieldsChanged.
  const snapshot: UndoSnapshot = {
    task_id: task.id,
    before_state: {
      id: task.id,
      title: task.title,
      done: false,
      done_at: null,
      archived_at: null,
      completion_count: task.completion_count,
      first_completed_at: task.first_completed_at,
      last_completed_at: task.last_completed_at,
    },
    after_state: {
      id: task.id,
      done: true,
      done_at: nowStr,
      archived_at: nowStr,
      completion_count: stats.completionCount,
      first_completed_at: stats.firstCompletedAt,
      last_completed_at: stats.lastCompletedAt,
      _completion: {
        user_id: userId,
        completed_at: nowStr,
        due_at_was: task.due_at,
        due_at_next: null,
      },
    } as Partial<Task> & { _completion: unknown },
    completion_id: completionId,
  }

  return { snapshot, completionId }
}
