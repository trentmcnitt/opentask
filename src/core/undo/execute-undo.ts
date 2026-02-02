/**
 * Surgical undo execution
 *
 * Undo only restores the fields that the original action changed.
 * This prevents undo from clobbering edits made between the action and the undo.
 */

import { getDb, withTransaction } from '@/core/db'
import type { UndoSnapshot, UndoResult } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { applyFieldsToTask } from './apply-fields'

/**
 * Execute undo for the most recent non-undone action
 *
 * @param userId The user performing the undo
 * @returns The result of the undo operation, or null if nothing to undo
 */
export function executeUndo(userId: number): UndoResult | null {
  const db = getDb()

  // Find the most recent non-undone action for this user
  const entry = db
    .prepare(
      `
    SELECT id, user_id, action, description, fields_changed, snapshot, undone
    FROM undo_log
    WHERE user_id = ? AND undone = 0
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .get(userId) as
    | {
        id: number
        user_id: number
        action: string
        description: string | null
        fields_changed: string
        snapshot: string
        undone: number
      }
    | undefined

  if (!entry) {
    return null
  }

  const fieldsChanged: string[] = JSON.parse(entry.fields_changed)
  const snapshots: UndoSnapshot[] = JSON.parse(entry.snapshot)

  return withTransaction((tx) => {
    // Handle special case: undoing a 'create' means soft-deleting the task
    if (entry.action === 'create') {
      const now = nowUtc()
      for (const snapshot of snapshots) {
        tx.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
          now,
          now,
          snapshot.task_id,
        )
      }
    } else {
      // Restore each task to its before_state for the changed fields only
      for (const snapshot of snapshots) {
        applyFieldsToTask(snapshot.task_id, snapshot.before_state, fieldsChanged)

        // If this was a recurring task completion, delete the completion record
        if (snapshot.completion_id) {
          tx.prepare('DELETE FROM completions WHERE id = ?').run(snapshot.completion_id)
        }
      }
    }

    // Mark the action as undone
    tx.prepare('UPDATE undo_log SET undone = 1 WHERE id = ?').run(entry.id)

    return {
      undone_action: entry.action as UndoResult['undone_action'],
      description: entry.description,
      tasks_affected: snapshots.length,
    }
  })
}
