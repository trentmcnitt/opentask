/**
 * Execution helper for mark-done operations
 *
 * Performs the database operations for marking a task done within
 * a transaction. Used by both single and bulk mark-done operations.
 */

import type { Database } from 'better-sqlite3'
import type { Task, UndoSnapshot } from '@/types'
import { createTaskSnapshot } from '@/core/undo'
import type { MarkDoneComputation } from './compute-mark-done'

export interface ExecuteMarkDoneResult {
  snapshot: UndoSnapshot
  completionId?: number
}

/**
 * Execute the database operations for marking a task done
 *
 * Must be called within a transaction. Creates completion records
 * for recurring tasks and updates task state.
 *
 * @param tx - Database transaction handle
 * @param task - The task being marked done
 * @param computation - Pre-computed state changes from computeMarkDone()
 * @param userId - User performing the action
 * @param nowStr - Current timestamp as ISO string
 * @returns Snapshot for undo and optional completionId for recurring tasks
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
    return executeOneOffMarkDone(tx, task, computation, nowStr)
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

  // Update task: advance due_at, clear original_due_at, update completion stats
  tx.prepare(
    `
    UPDATE tasks
    SET due_at = ?, original_due_at = NULL,
        completion_count = ?, first_completed_at = ?, last_completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextDueAt,
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
    original_due_at: null,
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
  nowStr: string,
): ExecuteMarkDoneResult {
  const { stats } = computation

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
      completion_count: stats.completionCount,
      first_completed_at: stats.firstCompletedAt,
      last_completed_at: stats.lastCompletedAt,
    },
    computation.fieldsChanged,
  )

  return { snapshot }
}
