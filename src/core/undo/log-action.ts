/**
 * Action logging for undo/redo
 *
 * Every mutating action writes to undo_log before applying changes.
 */

import type Database from 'better-sqlite3'
import { getDb } from '@/core/db'
import type { UndoAction, UndoSnapshot, Task, SlotUndoState } from '@/types'

/**
 * Log an action to the undo log
 *
 * @param userId The user performing the action
 * @param action The action type
 * @param description Human-readable description (e.g., "Marked 63 tasks done")
 * @param fieldsChanged Array of field names that were changed
 * @param snapshots Array of task snapshots (before/after state)
 * @param slotState The time slot row a time_slot_edit / time_slot_delete changed
 *   (see `SlotUndoState`); omitted by every task-only action
 */
export function logAction(
  userId: number,
  action: UndoAction,
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
  slotState?: SlotUndoState,
): number {
  const db = getDb()

  // Clear any redo entries (undone actions that are newer)
  // When a new action is performed, the redo stack is cleared
  db.prepare(
    `
    DELETE FROM undo_log
    WHERE user_id = ? AND undone = 1 AND id > (
      SELECT COALESCE(MAX(id), 0) FROM undo_log WHERE user_id = ? AND undone = 0
    )
  `,
  ).run(userId, userId)

  // Insert the new action
  const result = db
    .prepare(
      `
    INSERT INTO undo_log (user_id, action, description, fields_changed, snapshot, slot_state)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      userId,
      action,
      description,
      JSON.stringify(fieldsChanged),
      JSON.stringify(snapshots),
      slotState ? JSON.stringify(slotState) : null,
    )

  return Number(result.lastInsertRowid)
}

/**
 * Create a snapshot of a task's current state for specific fields
 */
export function createSnapshot(
  task: Partial<Task> & { id: number },
  fieldsChanged: string[],
): Partial<Task> {
  const snapshot: Partial<Task> = { id: task.id }

  // Always include title for activity display. This is safe because undo/redo
  // uses fieldsChanged (not snapshot keys) to determine which fields to restore.
  if ('title' in task && task.title !== undefined) {
    snapshot.title = task.title
  }

  for (const field of fieldsChanged) {
    if (field in task) {
      ;(snapshot as Record<string, unknown>)[field] = (task as Record<string, unknown>)[field]
    }
  }

  return snapshot
}

/**
 * The key a quota snapshot carries its period in. Not a column and never in
 * `fieldsChanged`, so `applyFieldsToTask` never writes it — it is a witness
 * that undo/redo read, like `_completion`. See `periodMoved`.
 */
export const PERIOD_WITNESS_KEY = '_period_start'

/**
 * A snapshot of a quota's count, stamped with the period it was counted in.
 *
 * A quota's count only means something inside its period. Undoing a +1 after
 * the period rolled over restored the OLD period's count into the new one — a
 * 2/2 from last week reappearing on Monday. Undo and redo skip a snapshot
 * whose period has moved on since (`periodMoved`), rather than refusing: a
 * throw inside `undoEntry` rolls back the `undone = 1` write too, and the
 * entry would wedge the top of the stack forever (the `is_tracked` lesson in
 * apply-fields.ts). The period that count belonged to is already closed and
 * recorded; there is nothing left in the task to put back.
 */
export function createQuotaSnapshot(
  beforeTask: Partial<Task> & { id: number; progress_period_start: string | null },
  afterTask: Partial<Task> & { id: number },
  fieldsChanged: string[],
): UndoSnapshot {
  const snapshot = createTaskSnapshot(beforeTask, afterTask, fieldsChanged)
  const witness = { [PERIOD_WITNESS_KEY]: beforeTask.progress_period_start }
  return {
    ...snapshot,
    before_state: { ...snapshot.before_state, ...witness },
    after_state: { ...snapshot.after_state, ...witness },
  }
}

/**
 * Has the quota this snapshot counted moved into a new period since? Only a
 * snapshot made by `createQuotaSnapshot` can say yes; every other snapshot
 * carries no witness and is applied as always.
 */
export function periodMoved(tx: Database.Database, snapshot: UndoSnapshot): boolean {
  const state = snapshot.before_state as Record<string, unknown>
  if (!(PERIOD_WITNESS_KEY in state)) return false
  const row = tx
    .prepare('SELECT progress_period_start FROM tasks WHERE id = ?')
    .get(snapshot.task_id) as { progress_period_start: string | null } | undefined
  if (!row) return false
  // An unanchored quota being anchored by the cron is not a new period — the
  // count it had is still the count of the period it is now anchored to.
  const witness = state[PERIOD_WITNESS_KEY] as string | null
  return witness !== null && row.progress_period_start !== witness
}

/**
 * Create before/after snapshots for a single task
 */
export function createTaskSnapshot(
  beforeTask: Partial<Task> & { id: number },
  afterTask: Partial<Task> & { id: number },
  fieldsChanged: string[],
  completionId?: number,
): UndoSnapshot {
  return {
    task_id: beforeTask.id,
    before_state: createSnapshot(beforeTask, fieldsChanged),
    after_state: createSnapshot(afterTask, fieldsChanged),
    completion_id: completionId,
  }
}
