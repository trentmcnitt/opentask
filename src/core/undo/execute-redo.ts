/**
 * Surgical redo execution
 *
 * Redo re-applies the after_state for fields that were changed.
 */

import Database from 'better-sqlite3'
import { reinsertCompletion } from './completion-row'
import { withTransaction } from '@/core/db'
import type { RedoResult } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { applyFieldsToTask } from './apply-fields'
import { periodMoved } from './log-action'
import { applyPromptDefault, applySlotRow } from './slot-row'
import { afterUndoRedo, selectUndoEntries, type ParsedUndoEntry } from './entries'

/**
 * Redo a single parsed entry within an existing transaction.
 * Used by both executeRedo (single) and executeBatchRedo (batch).
 */
export function redoEntry(tx: Database.Database, entry: ParsedUndoEntry): void {
  // A slot edit/delete: re-apply the slot change alongside its reminders and
  // quota prompt periods.
  if (entry.slotState) {
    applySlotRow(tx, entry.slotState.before, entry.slotState.after)
    applyPromptDefault(tx, entry.slotState, 'after')
  }

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
      // Same guard as undo: re-applying a count into a later period would
      // plant last period's number in this one (see `createQuotaSnapshot`).
      if (periodMoved(tx, snapshot)) continue
      applyFieldsToTask(snapshot.task_id, snapshot.after_state, entry.fieldsChanged)

      // A completion's row comes back; a put-back's row goes again.
      if (snapshot.completion_id) {
        if (entry.action === 'undone') {
          tx.prepare('DELETE FROM completions WHERE id = ?').run(snapshot.completion_id)
        } else {
          reinsertCompletion(tx, snapshot.completion_id, snapshot.task_id, snapshot.after_state)
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
  // The most recently undone action for this user: the oldest undone entry,
  // since undo marks entries from the top of the stack down
  const [parsed] = selectUndoEntries(userId, { undone: true, limit: 1 })
  if (!parsed) {
    return null
  }

  const result = withTransaction((tx) => {
    redoEntry(tx, parsed)

    return {
      redone_action: parsed.action as RedoResult['redone_action'],
      description: parsed.description,
      tasks_affected: parsed.snapshots.length,
    }
  })

  afterUndoRedo(userId, [parsed], 'redo')

  return result
}
