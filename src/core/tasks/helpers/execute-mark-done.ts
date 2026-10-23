/**
 * Execution helper for mark-done operations
 *
 * Performs the database operations for marking a task done within
 * a transaction. Used by both single and bulk mark-done operations.
 */

import type { Database } from 'better-sqlite3'
import type { Task, UndoSnapshot } from '@/types'
import type { MarkDoneComputation } from './compute-mark-done'
import { QUEUE_CLEAR_SQL, TARGET_SET_FIELD, queueStateToClear } from '../target-set'
import { DECK_CLEAR_SQL } from '../deck-clear'

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
  } else if (computation.type === 'series_end') {
    return executeSeriesEndMarkDone(tx, task, computation, userId, nowStr)
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
  const {
    nextDueAt,
    nextOccurrenceAt,
    nextDeadlineAt,
    nextLeadFrom,
    prevDueAt,
    prevOccurrenceAt,
    stats,
  } = computation

  // Create completion record. `occurrence_at_was` (§6, 2026-10-12): the
  // occurrence it closed, so a put-back restores the schedule with the target;
  // `occurrence_at_next` (2026-10-21): the one it advanced to, so put-back can
  // tell the schedule has not moved since — on a deadline-anchored repeat the
  // occurrence is not the target (`due_at_next`).
  const completionResult = tx
    .prepare(
      `
      INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next,
                               occurrence_at_was, occurrence_at_next, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      task.id,
      userId,
      nowStr,
      prevDueAt,
      nextDueAt,
      prevOccurrenceAt,
      nextOccurrenceAt,
      task.attempts ?? 0,
    )

  const completionId = Number(completionResult.lastInsertRowid)

  // Update task: advance the occurrence, its target and its deadline together
  // (the next occurrence's dates, from `occurrenceDates` in computeMarkDone),
  // set original_due_at to the target (the first target of the new
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
    SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?, lead_from = ?,
        ${TARGET_SET_FIELD} = ?, completion_count = ?, first_completed_at = ?, last_completed_at = ?,
        repeat_count_used = ?,
        progress_current = 0, attempts = 0, attempts_counted_through = NULL,
        ${QUEUE_CLEAR_SQL}, ${DECK_CLEAR_SQL}, updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextDueAt,
    nextOccurrenceAt, // the next scheduled occurrence (§6)
    nextDueAt, // original_due_at: the new occurrence's first target
    nextDeadlineAt, // the next occurrence's deadline (occurrenceDates), or null
    nextLeadFrom, // its lead day (the deadlines page), or null
    nowStr, // target_set_at: the next occurrence's wait counts from now
    stats.completionCount,
    stats.firstCompletedAt,
    stats.lastCompletedAt,
    computation.usedAfter,
    nowStr,
    task.id,
  )

  // The new target clears the queue state (target-set.ts); the snapshot
  // carries only the fields that were set.
  const queueClear = queueStateToClear(task)

  // Build snapshot with completion data for redo
  const afterState: Partial<Task> & { _completion?: unknown } = {
    ...queueClear.after,
    id: task.id,
    due_at: nextDueAt,
    occurrence_at: nextOccurrenceAt,
    original_due_at: nextDueAt,
    deadline_at: nextDeadlineAt,
    lead_from: nextLeadFrom,
    target_set_at: nowStr,
    progress_current: 0,
    completion_count: stats.completionCount,
    first_completed_at: stats.firstCompletedAt,
    last_completed_at: stats.lastCompletedAt,
    repeat_count_used: computation.usedAfter,
    // §7: a new occurrence starts its attempts afresh.
    attempts: 0,
    attempts_counted_through: null,
    // On deck (2026-10-20): the decked occurrence is done; the next is not on deck.
    ...(task.on_deck_day ? { on_deck_day: null } : {}),
    _completion: {
      user_id: userId,
      completed_at: nowStr,
      due_at_was: prevDueAt,
      due_at_next: nextDueAt,
      occurrence_at_was: prevOccurrenceAt,
      occurrence_at_next: nextOccurrenceAt,
      attempts: task.attempts ?? 0,
    },
  }

  const snapshot: UndoSnapshot = {
    task_id: task.id,
    before_state: {
      ...queueClear.before,
      id: task.id,
      title: task.title,
      due_at: task.due_at,
      occurrence_at: task.occurrence_at,
      original_due_at: task.original_due_at,
      deadline_at: task.deadline_at,
      lead_from: task.lead_from,
      target_set_at: task.target_set_at,
      progress_current: task.progress_current,
      completion_count: task.completion_count,
      first_completed_at: task.first_completed_at,
      last_completed_at: task.last_completed_at,
      repeat_count_used: task.repeat_count_used,
      attempts: task.attempts,
      attempts_counted_through: task.attempts_counted_through,
      ...(task.on_deck_day ? { on_deck_day: task.on_deck_day } : {}),
    },
    after_state: afterState,
    completion_id: completionId,
  }

  return { snapshot, completionId }
}

/**
 * REPEAT ENDS (2026-10-22): done on the last occurrence. The one-off write —
 * done, archived, stats, attempts reset, queue mark cleared — plus
 * `repeat_count_used`. `due_at`, `occurrence_at`, `deadline_at` and any deck
 * stay, so a put-back (`markUndone`) and undo restore the occurrence exactly.
 * The completion row records the occurrence it closed and no next one.
 */
function executeSeriesEndMarkDone(
  tx: Database,
  task: Task,
  computation: Extract<MarkDoneComputation, { type: 'series_end' }>,
  userId: number,
  nowStr: string,
): ExecuteMarkDoneResult {
  const { stats, usedAfter, prevOccurrenceAt } = computation
  const completionId = Number(
    tx
      .prepare(
        `INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next,
                                  occurrence_at_was, occurrence_at_next, attempts)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(task.id, userId, nowStr, task.due_at, prevOccurrenceAt, task.attempts ?? 0)
      .lastInsertRowid,
  )
  tx.prepare(
    `UPDATE tasks
        SET done = 1, done_at = ?, archived_at = ?, attempts = 0, attempts_counted_through = NULL,
            completion_count = ?, first_completed_at = ?, last_completed_at = ?,
            repeat_count_used = ?, queue_mark = 0, try_tomorrow = 0, updated_at = ?
      WHERE id = ?`,
  ).run(
    nowStr,
    nowStr,
    stats.completionCount,
    stats.firstCompletedAt,
    stats.lastCompletedAt,
    usedAfter,
    nowStr,
    task.id,
  )
  const queueClear = queueStateToClear(task, { includeQueued: false })
  const snapshot: UndoSnapshot = {
    task_id: task.id,
    before_state: {
      ...queueClear.before,
      id: task.id,
      title: task.title,
      done: false,
      done_at: null,
      archived_at: null,
      completion_count: task.completion_count,
      first_completed_at: task.first_completed_at,
      last_completed_at: task.last_completed_at,
      repeat_count_used: task.repeat_count_used,
      attempts: task.attempts,
      attempts_counted_through: task.attempts_counted_through,
    },
    after_state: {
      ...queueClear.after,
      id: task.id,
      done: true,
      done_at: nowStr,
      archived_at: nowStr,
      completion_count: stats.completionCount,
      first_completed_at: stats.firstCompletedAt,
      last_completed_at: stats.lastCompletedAt,
      repeat_count_used: usedAfter,
      attempts: 0,
      attempts_counted_through: null,
      _completion: {
        user_id: userId,
        completed_at: nowStr,
        due_at_was: task.due_at,
        due_at_next: null,
        occurrence_at_was: prevOccurrenceAt,
        occurrence_at_next: null,
        attempts: task.attempts ?? 0,
      },
    } as Partial<Task> & { _completion: unknown },
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
        queue_mark = 0, try_tomorrow = 0, updated_at = ?
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

  // The task queue: the mark and flag, when set (see computeMarkDone).
  const queueClear = queueStateToClear(task, { includeQueued: false })

  // Build snapshot manually (like recurring path) to include _completion data
  // for redo. createTaskSnapshot would strip _completion since it's not in
  // fieldsChanged.
  const snapshot: UndoSnapshot = {
    task_id: task.id,
    before_state: {
      ...queueClear.before,
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
      ...queueClear.after,
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
