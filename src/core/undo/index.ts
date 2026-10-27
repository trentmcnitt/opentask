/**
 * Undo/Redo module for OpenTask
 *
 * Provides surgical undo/redo functionality where only the changed fields
 * are restored, preventing clobbering of concurrent edits.
 */

export { logAction, createTaskSnapshot, createQuotaSnapshot } from './log-action'
export { executeUndo, undoLatest } from './execute-undo'
export type { UndoOutcome, UndoConflictReason } from './execute-undo'
export { executeRedo, redoNext } from './execute-redo'
export type { RedoOutcome, RedoConflictReason } from './execute-redo'
export { executeBatchUndo, executeBatchRedo } from './batch'
export type { BatchUndoOptions, BatchRedoOptions, BatchResult } from './batch'

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
    SELECT id, user_id, action, description, fields_changed, snapshot, created_at, undone,
           client, token_name
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
    client: string | null
    token_name: string | null
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
    client: e.client,
    token_name: e.token_name,
  }))
}

/**
 * Count undoable actions (non-undone entries) for a user.
 * When `afterId` is provided, only counts entries with id > afterId (session-scoped).
 * Also used as the boolean check: count > 0 means canUndo.
 */
export function countUndoable(userId: number, afterId?: number): number {
  const db = getDb()
  if (afterId !== undefined) {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM undo_log WHERE user_id = ? AND undone = 0 AND id > ?')
      .get(userId, afterId) as { count: number }
    return row.count
  }
  const row = db
    .prepare('SELECT COUNT(*) as count FROM undo_log WHERE user_id = ? AND undone = 0')
    .get(userId) as { count: number }
  return row.count
}

/**
 * Count redoable actions (undone entries) for a user.
 * When `afterId` is provided, only counts entries with id > afterId (session-scoped).
 */
export function countRedoable(userId: number, afterId?: number): number {
  const db = getDb()
  if (afterId !== undefined) {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM undo_log WHERE user_id = ? AND undone = 1 AND id > ?')
      .get(userId, afterId) as { count: number }
    return row.count
  }
  const row = db
    .prepare('SELECT COUNT(*) as count FROM undo_log WHERE user_id = ? AND undone = 1')
    .get(userId) as { count: number }
  return row.count
}

/**
 * Check if user can undo (has non-undone actions)
 */
export function canUndo(userId: number): boolean {
  return countUndoable(userId) > 0
}

/**
 * Check if user can redo (has undone actions)
 */
export function canRedo(userId: number): boolean {
  return countRedoable(userId) > 0
}

/**
 * Get the ID of the most recent undo_log entry for a user.
 * Used for session watermark initialization — the client stores this ID
 * on page load and prevents undo from going past it.
 */
export function getLatestUndoId(userId: number): number | null {
  const db = getDb()
  const row = db
    .prepare('SELECT MAX(id) as latest_id FROM undo_log WHERE user_id = ?')
    .get(userId) as { latest_id: number | null }
  return row.latest_id
}

/**
 * The entry a bare undo would take next: the newest not-undone one, or null
 * (2026-10-26). Unlike `getLatestUndoId`, an undone entry never counts. A
 * native surface enables its Undo only while its own last `undo_id` is this.
 */
export function getNewestUndoableId(userId: number): number | null {
  const row = getDb()
    .prepare('SELECT MAX(id) AS id FROM undo_log WHERE user_id = ? AND undone = 0')
    .get(userId) as { id: number | null }
  return row.id
}

/**
 * The entry a bare redo would take next: the oldest undone one (undo marks
 * from the top down, so it is the last one undone), or null (2026-10-26).
 * The same pick as `executeRedo` (`selectUndoEntries`, id ASC).
 */
export function getNextRedoableId(userId: number): number | null {
  const row = getDb()
    .prepare('SELECT MIN(id) AS id FROM undo_log WHERE user_id = ? AND undone = 1')
    .get(userId) as { id: number | null }
  return row.id
}
