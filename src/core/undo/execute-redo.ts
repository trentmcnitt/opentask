/**
 * Surgical redo execution
 *
 * Redo re-applies the after_state for fields that were changed.
 */

import { getDb, withTransaction } from '@/core/db'
import type { UndoSnapshot, RedoResult, Task } from '@/types'
import { nowUtc } from '@/core/recurrence'

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
  `
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

  return withTransaction((db) => {
    // Restore each task to its after_state for the changed fields only
    for (const snapshot of snapshots) {
      applyTaskFields(snapshot.task_id, snapshot.after_state, fieldsChanged)

      // If this was a recurring task completion, recreate the completion record
      if (snapshot.completion_id) {
        // We need to get the completion details from the after_state
        // The completion record details should have been stored in the snapshot
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
          db.prepare(
            `
            INSERT INTO completions (id, task_id, user_id, completed_at, due_at_was, due_at_next)
            VALUES (?, ?, ?, ?, ?, ?)
          `
          ).run(
            snapshot.completion_id,
            snapshot.task_id,
            comp.user_id,
            comp.completed_at,
            comp.due_at_was,
            comp.due_at_next
          )
        }
      }
    }

    // Mark the action as not undone (redo = undo the undo)
    db.prepare('UPDATE undo_log SET undone = 0 WHERE id = ?').run(entry.id)

    return {
      redone_action: entry.action as RedoResult['redone_action'],
      description: entry.description,
      tasks_affected: snapshots.length,
    }
  })
}

/**
 * Apply the after_state fields to a task (for redo)
 */
function applyTaskFields(
  taskId: number,
  afterState: Partial<Task>,
  fieldsChanged: string[]
): void {
  const db = getDb()

  // Build the SET clause for only the changed fields
  const setClauses: string[] = []
  const values: unknown[] = []

  for (const field of fieldsChanged) {
    if (field in afterState && field !== 'id') {
      // Handle special fields
      if (field === 'labels') {
        setClauses.push(`${field} = ?`)
        values.push(JSON.stringify(afterState[field as keyof Task]))
      } else if (field === 'done') {
        setClauses.push(`${field} = ?`)
        values.push((afterState as { done?: boolean }).done ? 1 : 0)
      } else {
        setClauses.push(`${field} = ?`)
        values.push((afterState as Record<string, unknown>)[field])
      }
    }
  }

  if (setClauses.length === 0) {
    return
  }

  // Always update updated_at
  setClauses.push('updated_at = ?')
  values.push(nowUtc())

  // Add task ID for WHERE clause
  values.push(taskId)

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  db.prepare(sql).run(...values)
}
