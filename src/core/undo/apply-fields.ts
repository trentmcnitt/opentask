/**
 * Shared field application logic for undo/redo operations.
 *
 * Both undo and redo need to surgically update specific fields on a task.
 * This module provides the shared implementation.
 */

import { getDb } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'

/**
 * Field name mapping for backward compatibility.
 * Maps old field names in undo snapshots to current database column names.
 */
const LEGACY_FIELD_MAP: Record<string, string> = {
  snoozed_from: 'original_due_at',
}

/**
 * Apply a partial state to a task, updating only the specified fields.
 *
 * Used by both undo (applying before_state) and redo (applying after_state).
 * Handles backward compatibility for old undo entries with renamed fields.
 */
export function applyFieldsToTask(
  taskId: number,
  state: Partial<Task>,
  fieldsChanged: string[],
): void {
  const db = getDb()

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const field of fieldsChanged) {
    // Map legacy field names to current names
    const dbColumn = LEGACY_FIELD_MAP[field] || field
    // Check both old and new field names in state object
    const stateKey = field in state ? field : dbColumn

    if (stateKey in state && dbColumn !== 'id') {
      if (dbColumn === 'labels') {
        setClauses.push(`${dbColumn} = ?`)
        values.push(JSON.stringify(state[stateKey as keyof Task]))
      } else if (dbColumn === 'done') {
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as { done?: boolean }).done ? 1 : 0)
      } else {
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as Record<string, unknown>)[stateKey])
      }
    }
  }

  if (setClauses.length === 0) {
    return
  }

  setClauses.push('updated_at = ?')
  values.push(nowUtc())

  values.push(taskId)

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  db.prepare(sql).run(...values)
}
