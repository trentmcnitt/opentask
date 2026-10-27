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
import { rolledOverSince } from './rollover-fence'
import { ensureLead, withoutAutoTarget } from './auto-target-fence'
import { compensate, countBefore } from './progress-compensation'
import { healRelativeLinks, rowsLinkedTo } from '@/core/tasks/relative-link-heal'
import { applyPromptDefault, applySlotRow, applyTargetRows, applyUserSettings } from './slot-row'
import { afterUndoRedo, entryState, selectUndoEntries, type ParsedUndoEntry } from './entries'

/**
 * Undo a single parsed entry within an existing transaction.
 * Used by both executeUndo (single) and executeBatchUndo (batch).
 */
export function undoEntry(tx: Database.Database, entry: ParsedUndoEntry): void {
  // A slot edit/delete: put the slot row back as it was, alongside the
  // reminders and quota prompt periods it moved (the ordinary snapshot loop
  // below), the default prompt period if the delete repointed it, and the
  // settings linked to it that the delete made custom (anchor times).
  if (entry.slotState) {
    applySlotRow(tx, entry.slotState.after, entry.slotState.before)
    applyPromptDefault(tx, entry.slotState, 'before')
    applyUserSettings(tx, entry.slotState, 'before', entry.id)
    applyTargetRows(tx, entry.slotState, 'before', entry.id)
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
      // The task queue's rollover changed this task after the entry was
      // written (B5): leave it as the rollover left it (`rollover-fence.ts`).
      if (rolledOverSince(tx, snapshot, entry.createdAt)) continue
      const count = countBefore(tx, snapshot, entry.fieldsChanged)
      // The task-queue switch is on and this would put an automatic target
      // back: applied without it, and given a lead day if it has none
      // (`auto-target-fence.ts`).
      const apply = withoutAutoTarget(snapshot.before_state, entry.fieldsChanged)
      applyFieldsToTask(snapshot.task_id, apply.state, apply.fields)
      if (apply.dropped) ensureLead(tx, snapshot.task_id)
      // A count moved back is logged as the opposite event (`compensate`).
      compensate(tx, entry.id, snapshot, count, 'undo')

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
  // A restored link is always re-validated against the current period
  // (relative targets, 2026-10-24): every task this entry touched — a
  // snapshot applied or skipped by a fence — and a period entry's linked rows.
  healRelativeLinks(tx, [
    ...entry.snapshots.map((s) => s.task_id),
    ...(entry.slotState
      ? rowsLinkedTo(
          tx,
          [entry.slotState.before?.id, entry.slotState.after?.id].filter(
            (id): id is number => id !== undefined,
          ),
        )
      : []),
  ])

  tx.prepare('UPDATE undo_log SET undone = 1 WHERE id = ?').run(entry.id)
}

/** Why a by-id undo refused: the entry is not the one a bare undo would take. */
export type UndoConflictReason = 'not_latest' | 'already_undone' | 'gone'

/** What `undoLatest` did. */
export type UndoOutcome =
  | { status: 'undone'; id: number; result: UndoResult }
  | { status: 'empty' }
  | { status: 'conflict'; reason: UndoConflictReason; newest_undoable_id: number | null }

/**
 * Undo the user's newest not-undone entry — only if it is `expectedId`, when
 * one is given (2026-10-26, scoped native Undo).
 *
 * A widget or the watch keeps the `undo_id` of its own last action and sends
 * it back: "undo THIS". If anything newer has been logged since (another
 * device, the web), or that entry was already undone or purged, nothing is
 * undone and the caller hears why (`conflict`, with what IS newest), instead
 * of an Undo quietly reversing someone else's action. The check reads the
 * stack inside the same transaction as the undo, so no write can land
 * between them. Without `expectedId` this is the bare undo, unchanged.
 */
export function undoLatest(userId: number, expectedId?: number): UndoOutcome {
  const outcome = withTransaction((tx): UndoOutcome & { entry?: ParsedUndoEntry } => {
    const [parsed] = selectUndoEntries(userId, { undone: false, limit: 1 })
    if (expectedId !== undefined && parsed?.id !== expectedId) {
      const state = entryState(userId, expectedId)
      return {
        status: 'conflict',
        reason: state === 'gone' ? 'gone' : state === 'undone' ? 'already_undone' : 'not_latest',
        newest_undoable_id: parsed?.id ?? null,
      }
    }
    if (!parsed) return { status: 'empty' }

    undoEntry(tx, parsed)
    return {
      status: 'undone',
      id: parsed.id,
      entry: parsed,
      result: {
        undone_action: parsed.action as UndoResult['undone_action'],
        description: parsed.description,
        tasks_affected: parsed.snapshots.length,
      },
    }
  })

  if (outcome.status !== 'undone') return outcome
  const { entry, ...done } = outcome
  afterUndoRedo(userId, [entry!], 'undo')
  return done
}

/**
 * Execute undo for the most recent non-undone action
 *
 * @param userId The user performing the undo
 * @returns The result of the undo operation, or null if nothing to undo
 */
export function executeUndo(userId: number): UndoResult | null {
  const outcome = undoLatest(userId)
  return outcome.status === 'undone' ? outcome.result : null
}
