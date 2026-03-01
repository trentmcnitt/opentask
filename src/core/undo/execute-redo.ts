/**
 * Surgical redo execution
 *
 * Redo re-applies the after_state for fields that were changed.
 */

import Database from 'better-sqlite3'
import { getDb, withTransaction } from '@/core/db'
import { emitSyncEvent } from '@/lib/sync-events'
import type { UndoSnapshot, RedoResult, Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { applyFieldsToTask } from './apply-fields'
import { dispatchUndoRedoWebhooks } from './dispatch-webhooks'

/** Parsed undo_log entry ready for redoEntry() */
export interface ParsedRedoEntry {
  id: number
  action: string
  description: string | null
  fieldsChanged: string[]
  snapshots: UndoSnapshot[]
}

/**
 * Redo a single parsed entry within an existing transaction.
 * Used by both executeRedo (single) and executeBatchRedo (batch).
 */
export function redoEntry(tx: Database.Database, entry: ParsedRedoEntry): void {
  // Handle special case: redoing a 'create' means restoring the task from trash
  if (entry.action === 'create') {
    const now = nowUtc()
    for (const snapshot of entry.snapshots) {
      tx.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        now,
        snapshot.task_id,
      )
    }
  } else {
    // Re-apply each task's after_state for the changed fields only
    for (const snapshot of entry.snapshots) {
      applyFieldsToTask(snapshot.task_id, snapshot.after_state, entry.fieldsChanged)

      // If this was a recurring task completion, recreate the completion record
      if (snapshot.completion_id) {
        const afterState = snapshot.after_state as Partial<Task> & {
          _completion?: {
            user_id: number
            completed_at: string
            due_at_was: string | null
            due_at_next: string | null
          }
        }

        if (afterState._completion) {
          const comp = afterState._completion
          tx.prepare(
            `
            INSERT INTO completions (id, task_id, user_id, completed_at, due_at_was, due_at_next)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          ).run(
            snapshot.completion_id,
            snapshot.task_id,
            comp.user_id,
            comp.completed_at,
            comp.due_at_was,
            comp.due_at_next,
          )
        }
      }
    }
  }

  // Mark the action as not undone (redo = undo the undo)
  tx.prepare('UPDATE undo_log SET undone = 0 WHERE id = ?').run(entry.id)
}

/**
 * Execute redo for the most recently undone action
 *
 * @param userId The user performing the redo
 * @returns The result of the redo operation, or null if nothing to redo
 */
export function executeRedo(userId: number): RedoResult | null {
  const db = getDb()

  // Find the most recently undone action for this user
  // (the oldest action where undone = 1 and it's the next in the undo sequence)
  const entry = db
    .prepare(
      `
    SELECT id, user_id, action, description, fields_changed, snapshot, undone
    FROM undo_log
    WHERE user_id = ? AND undone = 1
    ORDER BY id ASC
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

  const parsed: ParsedRedoEntry = {
    id: entry.id,
    action: entry.action,
    description: entry.description,
    fieldsChanged: JSON.parse(entry.fields_changed),
    snapshots: JSON.parse(entry.snapshot),
  }

  const result = withTransaction((tx) => {
    redoEntry(tx, parsed)

    return {
      redone_action: parsed.action as RedoResult['redone_action'],
      description: parsed.description,
      tasks_affected: parsed.snapshots.length,
    }
  })

  emitSyncEvent(userId)

  dispatchUndoRedoWebhooks(userId, parsed.snapshots, parsed.fieldsChanged, 'redo')

  return result
}
