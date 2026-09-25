/**
 * Slot rows in undo/redo (editable time slots, 2026-09-24)
 *
 * The undo log is task-shaped: every snapshot restores fields on a `tasks`
 * row. Two actions also change a `time_slots` row — moving a slot's start
 * (`time_slot_edit`) and removing a slot (`time_slot_delete`) — and both move
 * that slot's reminders so they stay in a slot. Undoing only the reminders
 * would put them back at times whose slot no longer exists (or has moved), so
 * the entry carries the slot row too (`undo_log.slot_state`), and undo/redo
 * write it back in the same transaction as the reminders.
 *
 * A deleted slot is restored under its ORIGINAL id. SQLite's AUTOINCREMENT
 * never hands a deleted id to a new row, so the id is still free, and keeping
 * it means anything that remembered the slot by id (a SLOT_REMINDER
 * notification's `slot_id` still on the lock screen) keeps pointing at it.
 */

import Database from 'better-sqlite3'
import type { SlotRow, SlotUndoState } from '@/types'
import { ValidationError } from '@/core/errors'

export function parseSlotState(raw: string | null | undefined): SlotUndoState | null {
  if (!raw) return null
  return JSON.parse(raw) as SlotUndoState
}

/**
 * Move one time_slots row from state `from` to state `to`.
 * `to: null` deletes it; otherwise it is inserted (under its own id) or
 * overwritten — the whole row, so undoing a move also reverts a rename made
 * after it (the same stack semantics every task field has).
 */
export function applySlotRow(
  tx: Database.Database,
  from: SlotRow | null,
  to: SlotRow | null,
): void {
  if (to === null) {
    if (from)
      tx.prepare('DELETE FROM time_slots WHERE id = ? AND user_id = ?').run(from.id, from.user_id)
    return
  }
  // Start times are unique per user. Between a change and its undo/redo the
  // user may have added (or moved) another slot onto this start — adding and
  // renaming are not undo entries, so they don't clear the redo stack. Refuse
  // rather than create two slots on one boundary; the throw rolls back the
  // whole undo, so nothing is half-applied and the entry stays available.
  const clash = tx
    .prepare('SELECT label FROM time_slots WHERE user_id = ? AND start_time = ? AND id != ?')
    .get(to.user_id, to.start_time, to.id) as { label: string } | undefined
  if (clash) {
    throw new ValidationError(
      `Can't restore "${to.label}": "${clash.label}" already starts at ${to.start_time}`,
    )
  }
  tx.prepare(
    `INSERT INTO time_slots (id, user_id, label, start_time, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       start_time = excluded.start_time,
       sort_order = excluded.sort_order`,
  ).run(to.id, to.user_id, to.label, to.start_time, to.sort_order, to.created_at)
}
