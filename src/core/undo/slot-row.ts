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
import { applySettingChanges, readAnchorRow } from '@/core/users/anchor-times'
import { unlinkSlot } from '@/lib/anchor-times'

/**
 * Write the user's default quota prompt period back to one side of a slot
 * entry (`SlotUndoState.prompt_default`): `before` on undo, `after` on redo.
 * Deleting a slot repoints the default, like the quotas' own stored periods,
 * so the removed slot's prompts land where its reminders do
 * (`src/core/time-slots/edit.ts`). No-op on entries without it.
 */
export function applyPromptDefault(
  tx: Database.Database,
  state: SlotUndoState,
  side: 'before' | 'after',
): void {
  const change = state.prompt_default
  const userId = state.before?.user_id ?? state.after?.user_id
  if (!change || userId === undefined) return
  tx.prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(change[side], userId)
}

/**
 * The user's settings linked to a deleted period (Morning, Wake, Sleep,
 * number-pad buttons — `SlotUndoState.user_settings`), on undo and redo of
 * the delete. Called after `applySlotRow`, so the period is already back (or
 * gone again).
 *
 * UNDO writes the recorded links back, compare-and-set per setting: one the
 * user has changed since keeps the newer value (`settingWrites`).
 *
 * REDO deletes the period again, so whatever links to it NOW must become
 * custom — not only what linked to it the first time: between the undo and
 * the redo the user may have linked another setting to the restored period,
 * and replaying the recorded changes alone would leave that one pointing at
 * a period that no longer exists. So redo unlinks the current row
 * (`unlinkSlot`) and rewrites the entry's record to match (`entryId`), so a
 * later undo puts back exactly what this redo converted.
 */
export function applyUserSettings(
  tx: Database.Database,
  state: SlotUndoState,
  side: 'before' | 'after',
  entryId: number,
): void {
  const userId = state.before?.user_id ?? state.after?.user_id
  if (userId === undefined) return
  if (side === 'after' && state.after === null && state.before) {
    const changes = unlinkSlot(readAnchorRow(userId, tx), state.before)
    applySettingChanges(tx, userId, changes, 'after')
    const next: SlotUndoState = { ...state, user_settings: changes.length ? changes : undefined }
    tx.prepare('UPDATE undo_log SET slot_state = ? WHERE id = ?').run(JSON.stringify(next), entryId)
    return
  }
  if (state.user_settings) applySettingChanges(tx, userId, state.user_settings, side)
}

/** A row is CLOSED for the period hooks: done, archived or trashed (`time-slots/edit.ts`). */
const CLOSED_SQL = '(done = 1 OR archived_at IS NOT NULL OR deleted_at IS NOT NULL)'

/**
 * RELATIVE TARGETS (2026-10-24): the CLOSED rows a period entry moved in one
 * statement (`SlotUndoState.target_times` / `target_unlinked`), on undo and
 * redo — the open rows ride the entry's snapshots. Called after
 * `applySlotRow` (the period is back, or gone again). Compare-and-set, by
 * the owner:
 *  - a RETIME's mirror: `target_time` from one side's start to the other's,
 *    only on rows still linked to the period and still at that time;
 *  - a DELETE's undo re-links the recorded rows still unlinked and still at
 *    the period's start; its REDO unlinks whatever closed row links to the
 *    period NOW (as `applyUserSettings` does) and rewrites the record, so a
 *    later undo puts back exactly what this redo unlinked.
 */
export function applyTargetRows(
  tx: Database.Database,
  state: SlotUndoState,
  side: 'before' | 'after',
  entryId: number,
): void {
  const userId = state.before?.user_id ?? state.after?.user_id
  if (userId === undefined) return
  const times = state.target_times
  if (times) {
    const [from, to] = side === 'before' ? [times.after, times.before] : [times.before, times.after]
    tx.prepare(
      `UPDATE tasks SET target_time = ?
        WHERE user_id = ? AND target_slot_id = ? AND target_time = ? AND ${CLOSED_SQL}`,
    ).run(to, userId, times.slot_id, from)
  }
  const removed = state.after === null ? state.before : null
  if (!removed) return
  if (side === 'before') {
    const ids = state.target_unlinked ?? []
    if (ids.length === 0) return
    tx.prepare(
      `UPDATE tasks SET target_slot_id = ?
        WHERE user_id = ? AND target_slot_id IS NULL AND target_time = ?
          AND id IN (${ids.map(() => '?').join(', ')})`,
    ).run(removed.id, userId, removed.start_time, ...ids)
    return
  }
  const ids = (
    tx
      .prepare(`SELECT id FROM tasks WHERE user_id = ? AND target_slot_id = ? AND ${CLOSED_SQL}`)
      .all(userId, removed.id) as { id: number }[]
  ).map((r) => r.id)
  if (ids.length > 0) {
    tx.prepare(
      `UPDATE tasks SET target_slot_id = NULL WHERE user_id = ? AND target_slot_id = ? AND ${CLOSED_SQL}`,
    ).run(userId, removed.id)
  }
  // The record as this redo left it, over whatever `applyUserSettings` wrote.
  const row = tx.prepare('SELECT slot_state FROM undo_log WHERE id = ?').get(entryId) as
    | { slot_state: string | null }
    | undefined
  const current = parseSlotState(row?.slot_state) ?? state
  const next: SlotUndoState = { ...current, target_unlinked: ids.length ? ids : undefined }
  tx.prepare('UPDATE undo_log SET slot_state = ? WHERE id = ?').run(JSON.stringify(next), entryId)
}

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
