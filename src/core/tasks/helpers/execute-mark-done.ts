/**
 * Execution helper for mark-done operations
 *
 * Performs the database operations for marking a task done within
 * a transaction. Used by both single and bulk mark-done operations.
 */

import type { Database } from 'better-sqlite3'
import type { Task, UndoSnapshot } from '@/types'
import type { MarkDoneComputation } from './compute-mark-done'
import { TARGET_SET_FIELD } from '../target-set'

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
  const { nextDueAt, nextOccurrenceAt, nextDeadlineAt, prevDueAt, prevOccurrenceAt, stats } =
    computation

  // Create completion record. `occurrence_at_was` (§6, 2026-10-12): the
  // occurrence it closed, so a put-back restores the schedule with the target.
  const completionResult = tx
    .prepare(
      `
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next, occurrence_at_was, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(task.id, userId, nowStr, prevDueAt, nextDueAt, prevOccurrenceAt, task.attempts ?? 0)

  const completionId = Number(completionResult.lastInsertRowid)

  // Update task: advance the occurrence and the target together (§6: both
  // land on the next scheduled occurrence; the target capped at the moved
  // deadline), set original_due_at to it (the first target of the new
  // occurrence — old native builds read it), update completion stats
  //
  // §5: `progress_current = 0` only matters for a quota, and a quota reaches
  // this path only through `close_period` — an API-only early close (see
  // progress.ts). Quota periods normally end in the period-rollover cron
  // (`period-rollover.ts`), which records a `progress_periods` row; this early
  // close writes none and leaves the period anchor where it is. For an
  // ordinary recurring task the column is normally 0 already.
  tx.prepare(
    `
    UPDATE tasks
    SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?, ${TARGET_SET_FIELD} = ?,
        completion_count = ?, first_completed_at = ?, last_completed_at = ?,
        progress_current = 0, attempts = 0, attempts_counted_through = NULL,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextDueAt,
    nextOccurrenceAt, // the next scheduled occurrence (§6)
    nextDueAt, // original_due_at: the new occurrence's first target
    nextDeadlineAt, // the deadline moves with the occurrence (advanceDeadline)
    nowStr, // target_set_at: the next occurrence's wait counts from now
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
    occurrence_at: nextOccurrenceAt,
    original_due_at: nextDueAt,
    deadline_at: nextDeadlineAt,
    target_set_at: nowStr,
    progress_current: 0,
    completion_count: stats.completionCount,
    first_completed_at: stats.firstCompletedAt,
    last_completed_at: stats.lastCompletedAt,
    // §7: a new occurrence starts its attempts afresh.
    attempts: 0,
    attempts_counted_through: null,
    _completion: {
      user_id: userId,
      completed_at: nowStr,
      due_at_was: prevDueAt,
      due_at_next: nextDueAt,
      occurrence_at_was: prevOccurrenceAt,
      attempts: task.attempts ?? 0,
    },
  }

  const snapshot: UndoSnapshot = {
    task_id: task.id,
    before_state: {
      id: task.id,
      title: task.title,
      due_at: task.due_at,
      occurrence_at: task.occurrence_at,
      original_due_at: task.original_due_at,
      deadline_at: task.deadline_at,
      target_set_at: task.target_set_at,
      progress_current: task.progress_current,
      completion_count: task.completion_count,
      first_completed_at: task.first_completed_at,
      last_completed_at: task.last_completed_at,
      attempts: task.attempts,
      attempts_counted_through: task.attempts_counted_through,
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
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next, attempts)
      VALUES (?, ?, ?, ?, NULL, ?)
    `,
    )
    .run(task.id, userId, nowStr, task.due_at, task.attempts ?? 0)

  const completionId = Number(completionResult.lastInsertRowid)

  // Update task: set done=1, done_at, archived_at, update completion stats
  tx.prepare(
    `
    UPDATE tasks
    SET done = 1, done_at = ?, archived_at = ?, attempts = 0, attempts_counted_through = NULL,
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
      attempts: task.attempts,
      attempts_counted_through: task.attempts_counted_through,
    },
    after_state: {
      id: task.id,
      done: true,
      attempts: 0,
      attempts_counted_through: null,
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
        attempts: task.attempts ?? 0,
      },
    } as Partial<Task> & { _completion: unknown },
    completion_id: completionId,
  }

  return { snapshot, completionId }
}
