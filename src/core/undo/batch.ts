/**
 * Batch undo/redo operations
 *
 * Undoes or redoes multiple entries atomically within a single transaction.
 * Supports three modes:
 * - sessionStartId: undo all entries after this ID (session boundary)
 * - throughId: undo/redo entries down to (and including) this specific entry
 * - count: undo/redo a specific number of entries
 */

import { getDb, withTransaction } from '@/core/db'
import { emitSyncEvent } from '@/lib/sync-events'
import type { UndoSnapshot } from '@/types'
import { undoEntry, type ParsedUndoEntry } from './execute-undo'
import { redoEntry, type ParsedRedoEntry } from './execute-redo'
import { countUndoable, countRedoable } from './index'

interface RawEntry {
  id: number
  action: string
  description: string | null
  fields_changed: string
  snapshot: string
}

export interface BatchUndoOptions {
  sessionStartId?: number
  throughId?: number
  count?: number
}

export interface BatchRedoOptions {
  throughId?: number
  count?: number
}

export interface BatchResult {
  count: number
  remaining_undoable: number
  remaining_redoable: number
}

/**
 * Undo multiple entries atomically.
 *
 * Entries are undone from the top of the stack (most recent first) down to the
 * specified boundary. All entries are undone within a single transaction so
 * either all succeed or none do.
 */
export function executeBatchUndo(userId: number, options: BatchUndoOptions): BatchResult {
  const db = getDb()

  // Build the query to find entries to undo
  let sql = `
    SELECT id, action, description, fields_changed, snapshot
    FROM undo_log
    WHERE user_id = ? AND undone = 0
  `
  const params: (number | string)[] = [userId]

  if (options.sessionStartId !== undefined) {
    sql += ' AND id > ?'
    params.push(options.sessionStartId)
  }

  if (options.throughId !== undefined) {
    sql += ' AND id >= ?'
    params.push(options.throughId)
  }

  sql += ' ORDER BY id DESC'

  if (options.count !== undefined) {
    sql += ' LIMIT ?'
    params.push(options.count)
  }

  const entries = db.prepare(sql).all(...params) as RawEntry[]

  if (entries.length === 0) {
    return {
      count: 0,
      remaining_undoable: countUndoable(userId),
      remaining_redoable: countRedoable(userId),
    }
  }

  const parsed: ParsedUndoEntry[] = entries.map((e) => ({
    id: e.id,
    action: e.action,
    description: e.description,
    fieldsChanged: JSON.parse(e.fields_changed),
    snapshots: JSON.parse(e.snapshot) as UndoSnapshot[],
  }))

  withTransaction((tx) => {
    for (const entry of parsed) {
      undoEntry(tx, entry)
    }
  })

  emitSyncEvent(userId)

  return {
    count: parsed.length,
    remaining_undoable: countUndoable(userId),
    remaining_redoable: countRedoable(userId),
  }
}

/**
 * Redo multiple entries atomically.
 *
 * Entries are redone from the bottom of the undo stack (oldest undone first)
 * up to the specified boundary. All entries are redone within a single
 * transaction.
 */
export function executeBatchRedo(userId: number, options: BatchRedoOptions): BatchResult {
  const db = getDb()

  let sql = `
    SELECT id, action, description, fields_changed, snapshot
    FROM undo_log
    WHERE user_id = ? AND undone = 1
  `
  const params: (number | string)[] = [userId]

  if (options.throughId !== undefined) {
    sql += ' AND id <= ?'
    params.push(options.throughId)
  }

  // Redo in ascending order (oldest undone first) to maintain consistency
  sql += ' ORDER BY id ASC'

  if (options.count !== undefined) {
    sql += ' LIMIT ?'
    params.push(options.count)
  }

  const entries = db.prepare(sql).all(...params) as RawEntry[]

  if (entries.length === 0) {
    return {
      count: 0,
      remaining_undoable: countUndoable(userId),
      remaining_redoable: countRedoable(userId),
    }
  }

  const parsed: ParsedRedoEntry[] = entries.map((e) => ({
    id: e.id,
    action: e.action,
    description: e.description,
    fieldsChanged: JSON.parse(e.fields_changed),
    snapshots: JSON.parse(e.snapshot) as UndoSnapshot[],
  }))

  withTransaction((tx) => {
    for (const entry of parsed) {
      redoEntry(tx, entry)
    }
  })

  emitSyncEvent(userId)

  return {
    count: parsed.length,
    remaining_undoable: countUndoable(userId),
    remaining_redoable: countRedoable(userId),
  }
}
