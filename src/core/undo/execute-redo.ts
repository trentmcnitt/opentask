/**
 * Surgical redo execution
 *
 * Redo re-applies the after_state for fields that were changed.
 */

import Database from 'better-sqlite3'
import { reinsertCompletion } from './completion-row'
import { getDb, withTransaction } from '@/core/db'
import { emitSyncEvent } from '@/lib/sync-events'
import type { UndoSnapshot, RedoResult, SlotUndoState } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { applyFieldsToTask } from './apply-fields'
import { periodMoved } from './log-action'
import { applySlotRow, parseSlotState } from './slot-row'
import { dispatchUndoRedoWebhooks } from './dispatch-webhooks'

/** Parsed undo_log entry ready for redoEntry() */
export interface ParsedRedoEntry {
  id: number
  action: string
  description: string | null
  fieldsChanged: string[]
  snapshots: UndoSnapshot[]
  /** Set only on time_slot_edit / time_slot_delete entries. */
  slotState?: SlotUndoState | null
}

/**
 * Redo a single parsed entry within an existing transaction.
 * Used by both executeRedo (single) and executeBatchRedo (batch).
 */
export function redoEntry(tx: Database.Database, entry: ParsedRedoEntry): void {
  // A slot edit/delete: re-apply the slot change alongside its reminders.
  if (entry.slotState) applySlotRow(tx, entry.slotState.before, entry.slotState.after)

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
  const db = getDb()

  // Find the most recently undone action for this user
  // (the oldest action where undone = 1 and it's the next in the undo sequence)
  const entry = db
    .prepare(
      `
    SELECT id, user_id, action, description, fields_changed, snapshot, slot_state, undone
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
        slot_state: string | null
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
    slotState: parseSlotState(entry.slot_state),
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
