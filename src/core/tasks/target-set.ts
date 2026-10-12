/**
 * `target_set_at` — when a task's target was last SET, by any path
 * (2026-10-12, docs/TASK-MODEL.md § Upcoming). It is the anchor of Upcoming's
 * wait: the heads-up days are counted from the local day the target was set
 * to the local day it arrives (`src/lib/task-segments.ts`).
 *
 * THE RULE: every write that changes `due_at` or `deadline_at` stamps it, in
 * the same UPDATE, and puts it in the undo snapshot so undo and redo restore
 * it. A deadline change counts because it moves the EFFECTIVE target (the
 * deadline's implied one).
 *
 * WHY A HELPER AND NOT ONE CALL SITE. `collectFieldChanges` covers update, bulk
 * edit, bulk snooze, snooze-overdue, the snooze endpoint, Today and the
 * time-slot moves, but create, a completion advance, skip, put-back
 * (`markUndone`) and AI enrichment write `due_at` with SQL of their own. Each
 * of those imports this module; `tests/behavioral/up-target-set-writers.test.ts`
 * fails when a file under `src/core` writes `due_at` / `deadline_at` without
 * importing it (and exercises every path), so a new writer can't skip it.
 *
 * Undo / redo never stamp: they restore the snapshot's value.
 * Distinct from `segment_targeted_at` (targeted FROM a task segment only).
 *
 * THE ATTEMPTS CHECKPOINT (spec §7, 2026-10-12) rides on the same stamp. The
 * attempts read (`effectiveAttempts`) assumes the target has not moved since
 * `attempts_counted_through`; so every write that moves the target first
 * persists the count as of now, read from the row BEFORE the move (the
 * `Task` every writer already holds is read through `rowToTask`, which
 * computes it). Without it, a task that went over target at 9:00 and was
 * moved at 9:00:30, before the minute cron, would lose that day's attempt.
 * The checkpoint is an observation of the past, like the cron's, so it is
 * not in `fieldsChanged`: undo of the move restores the old target and leaves
 * the count, which is still true.
 */

import type { Task } from '@/types'

/** The column, for the writers whose SQL is a fixed statement. */
export const TARGET_SET_FIELD = 'target_set_at'

/** Whether a write that changed these fields moves the target (and so must stamp). */
export function movesTarget(fieldsChanged: readonly string[]): boolean {
  return fieldsChanged.includes('due_at') || fieldsChanged.includes('deadline_at')
}

/** A write being collected clause by clause (`collectFieldChanges`, enrichment). */
export interface CollectedWrite {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
  beforeState?: Partial<Task>
  afterState?: Partial<Task>
}

/**
 * Add `target_set_at = now` to a collected write when it moves the target.
 * Pushes the clause and its value together (they are bound in order), the
 * field, and — when the write keeps snapshot states — the before/after
 * values, so the undo entry restores it. Returns whether it stamped.
 */
export function stampTargetSet(
  write: CollectedWrite,
  task: Pick<Task, 'target_set_at'> & Partial<Pick<Task, 'attempts' | 'attempts_counted_through'>>,
  nowStr: string,
): boolean {
  if (!movesTarget(write.fieldsChanged) || write.fieldsChanged.includes(TARGET_SET_FIELD)) {
    return false
  }
  if (typeof task.attempts === 'number' && !write.fieldsChanged.includes('attempts')) {
    write.setClauses.push('attempts = ?', 'attempts_counted_through = ?')
    write.values.push(task.attempts, task.attempts_counted_through ?? null)
  }
  write.setClauses.push(`${TARGET_SET_FIELD} = ?`)
  write.values.push(nowStr)
  write.fieldsChanged.push(TARGET_SET_FIELD)
  if (write.beforeState) write.beforeState.target_set_at = task.target_set_at
  if (write.afterState) write.afterState.target_set_at = nowStr
  return true
}
