/**
 * Batch undo/redo operations
 *
 * Undoes or redoes multiple entries atomically within a single transaction.
 * Supports three modes:
 * - sessionStartId: undo all entries after this ID (session boundary)
 * - throughId: undo/redo entries down to (and including) this specific entry
 * - count: undo/redo a specific number of entries
 */

import { withTransaction } from '@/core/db'
import { undoEntry } from './execute-undo'
import { redoEntry } from './execute-redo'
import { afterUndoRedo, selectUndoEntries } from './entries'
import { countUndoable, countRedoable } from './index'

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
  // From the top of the stack down to the boundary
  const entries = selectUndoEntries(userId, {
    undone: false,
    afterId: options.sessionStartId,
    fromId: options.throughId,
    limit: options.count,
  })

  if (entries.length === 0) {
    return {
      count: 0,
      remaining_undoable: countUndoable(userId),
      remaining_redoable: countRedoable(userId),
    }
  }

  withTransaction((tx) => {
    for (const entry of entries) {
      undoEntry(tx, entry)
    }
  })

  afterUndoRedo(userId, entries, 'undo')

  return {
    count: entries.length,
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
  // Oldest undone first, up to the boundary, so entries are redone in the
  // order they were originally made
  const entries = selectUndoEntries(userId, {
    undone: true,
    throughId: options.throughId,
    limit: options.count,
  })

  if (entries.length === 0) {
    return {
      count: 0,
      remaining_undoable: countUndoable(userId),
      remaining_redoable: countRedoable(userId),
    }
  }

  withTransaction((tx) => {
    for (const entry of entries) {
      redoEntry(tx, entry)
    }
  })

  afterUndoRedo(userId, entries, 'redo')

  return {
    count: entries.length,
    remaining_undoable: countUndoable(userId),
    remaining_redoable: countRedoable(userId),
  }
}
