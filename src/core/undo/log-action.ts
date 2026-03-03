/**
 * Action logging for undo/redo
 *
 * Every mutating action writes to undo_log before applying changes.
 */

import { getDb } from '@/core/db'
import type { UndoAction, UndoSnapshot, Task } from '@/types'

/**
 * Log an action to the undo log
 *
 * @param userId The user performing the action
 * @param action The action type
 * @param description Human-readable description (e.g., "Marked 63 tasks done")
 * @param fieldsChanged Array of field names that were changed
 * @param snapshots Array of task snapshots (before/after state)
 */
export function logAction(
  userId: number,
  action: UndoAction,
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
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
    INSERT INTO undo_log (user_id, action, description, fields_changed, snapshot)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(userId, action, description, JSON.stringify(fieldsChanged), JSON.stringify(snapshots))

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
