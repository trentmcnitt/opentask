/**
 * Undo/Redo module for OpenTask
 *
 * Provides surgical undo/redo functionality where only the changed fields
 * are restored, preventing clobbering of concurrent edits.
 */

export { logAction, createSnapshot, createTaskSnapshot } from './log-action'
export { executeUndo } from './execute-undo'
export { executeRedo } from './execute-redo'

/**
 * Get undo history for a user
 */
import { getDb } from '@/core/db'
import type { UndoLogEntry } from '@/types'

export function getUndoHistory(userId: number, limit: number = 50): UndoLogEntry[] {
  const db = getDb()

  const entries = db
    .prepare(
      `
    SELECT id, user_id, action, description, fields_changed, snapshot, created_at, undone
    FROM undo_log
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `,
    )
    .all(userId, limit) as Array<{
    id: number
    user_id: number
    action: string
    description: string | null
    fields_changed: string
    snapshot: string
    created_at: string
    undone: number
  }>

  return entries.map((e) => ({
    id: e.id,
    user_id: e.user_id,
    action: e.action as UndoLogEntry['action'],
    description: e.description,
    fields_changed: JSON.parse(e.fields_changed),
    snapshot: JSON.parse(e.snapshot),
    created_at: e.created_at,
    undone: e.undone === 1,
  }))
}

/**
 * Check if user can undo (has non-undone actions)
 */
export function canUndo(userId: number): boolean {
  const db = getDb()

  const count = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM undo_log
    WHERE user_id = ? AND undone = 0
  `,
    )
    .get(userId) as { count: number }

  return count.count > 0
}

/**
 * Check if user can redo (has undone actions)
 */
export function canRedo(userId: number): boolean {
  const db = getDb()

  const count = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM undo_log
    WHERE user_id = ? AND undone = 1
  `,
    )
    .get(userId) as { count: number }

  return count.count > 0
}
