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
 * Apply a partial state to a task, updating only the specified fields.
 *
 * Used by both undo (applying before_state) and redo (applying after_state).
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
    if (field in state && field !== 'id') {
      if (field === 'labels') {
        setClauses.push(`${field} = ?`)
        values.push(JSON.stringify(state[field as keyof Task]))
      } else if (field === 'done') {
        setClauses.push(`${field} = ?`)
        values.push((state as { done?: boolean }).done ? 1 : 0)
      } else {
        setClauses.push(`${field} = ?`)
        values.push((state as Record<string, unknown>)[field])
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
