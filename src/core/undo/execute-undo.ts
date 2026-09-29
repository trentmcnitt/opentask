/**
 * Surgical undo execution
 *
 * Undo only restores the fields that the original action changed.
 * This prevents undo from clobbering edits made between the action and the undo.
 */

import Database from 'better-sqlite3'
import { reinsertCompletion } from './completion-row'
import { withTransaction } from '@/core/db'
import type { UndoResult } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { applyFieldsToTask } from './apply-fields'
import { periodMoved } from './log-action'
import { applyPromptDefault, applySlotRow } from './slot-row'
import { afterUndoRedo, selectUndoEntries, type ParsedUndoEntry } from './entries'

/**
 * Undo a single parsed entry within an existing transaction.
 * Used by both executeUndo (single) and executeBatchUndo (batch).
 */
export function undoEntry(tx: Database.Database, entry: ParsedUndoEntry): void {
  // A slot edit/delete: put the slot row back as it was, alongside the
  // reminders and quota prompt periods it moved (the ordinary snapshot loop
  // below), and the default prompt period if the delete repointed it.
  if (entry.slotState) {
    applySlotRow(tx, entry.slotState.after, entry.slotState.before)
    applyPromptDefault(tx, entry.slotState, 'before')
  }

  // Handle special case: undoing a 'create' means soft-deleting the task
  if (entry.action === 'create') {
    const now = nowUtc()
    for (const snapshot of entry.snapshots) {
      tx.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        snapshot.task_id,
      )
    }
  } else {
    // Restore each task to its before_state for the changed fields only
    for (const snapshot of entry.snapshots) {
      // A quota count from a period that has since closed: nothing to restore
      // (see `createQuotaSnapshot`). The entry is still marked undone below.
      if (periodMoved(tx, snapshot)) continue
      applyFieldsToTask(snapshot.task_id, snapshot.before_state, entry.fieldsChanged)

      // A completion's row goes with it; a put-back's row comes back.
      if (snapshot.completion_id) {
        if (entry.action === 'undone') {
          reinsertCompletion(tx, snapshot.completion_id, snapshot.task_id, snapshot.before_state)
        } else {
          tx.prepare('DELETE FROM completions WHERE id = ?').run(snapshot.completion_id)
        }
      }
    }
  }

  // Mark the action as undone
  tx.prepare('UPDATE undo_log SET undone = 1 WHERE id = ?').run(entry.id)
}

/**
 * Execute undo for the most recent non-undone action
 *
 * @param userId The user performing the undo
 * @returns The result of the undo operation, or null if nothing to undo
 */
export function executeUndo(userId: number): UndoResult | null {
  // The most recent non-undone action for this user
  const [parsed] = selectUndoEntries(userId, { undone: false, limit: 1 })
  if (!parsed) {
    return null
  }

  const result = withTransaction((tx) => {
    undoEntry(tx, parsed)

    return {
      undone_action: parsed.action as UndoResult['undone_action'],
      description: parsed.description,
      tasks_affected: parsed.snapshots.length,
    }
  })

  afterUndoRedo(userId, [parsed], 'undo')

  return result
}
