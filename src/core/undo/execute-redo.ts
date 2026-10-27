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
import { rolledOverSince } from './rollover-fence'
import { ensureLead, withoutAutoTarget } from './auto-target-fence'
import { compensate, countBefore } from './progress-compensation'
import { healRelativeLinks, rowsLinkedTo } from '@/core/tasks/relative-link-heal'
import { applyPromptDefault, applySlotRow, applyTargetRows, applyUserSettings } from './slot-row'
import { afterUndoRedo, entryState, selectUndoEntries, type ParsedUndoEntry } from './entries'

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
    applyUserSettings(tx, entry.slotState, 'after', entry.id)
    applyTargetRows(tx, entry.slotState, 'after', entry.id)
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
      // The task queue's rollover changed this task after the entry was
      // written (B5): leave it as the rollover left it (`rollover-fence.ts`).
      if (rolledOverSince(tx, snapshot, entry.createdAt)) continue
      const count = countBefore(tx, snapshot, entry.fieldsChanged)
      // The task-queue switch is on and this would put an automatic target
      // back: applied without it, and given a lead day if it has none
      // (`auto-target-fence.ts`).
      const apply = withoutAutoTarget(snapshot.after_state, entry.fieldsChanged)
      applyFieldsToTask(snapshot.task_id, apply.state, apply.fields)
      if (apply.dropped) ensureLead(tx, snapshot.task_id)
      // The count moved again: logged again, as a redo (`compensate`).
      compensate(tx, entry.id, snapshot, count, 'redo')

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

  tx.prepare('UPDATE undo_log SET undone = 0 WHERE id = ?').run(entry.id)
}

/** Why a by-id redo refused: the entry is not the one a bare redo would take. */
export type RedoConflictReason = 'not_next' | 'not_undone' | 'gone'

/** What `redoNext` did. */
export type RedoOutcome =
  | { status: 'redone'; id: number; result: RedoResult }
  | { status: 'empty' }
  | { status: 'conflict'; reason: RedoConflictReason; next_redoable_id: number | null }

/**
 * Redo the entry a bare redo would take — the oldest undone one, since undo
 * marks entries from the top of the stack down — only if it is `expectedId`,
 * when one is given (2026-10-26, scoped native Undo; `undoLatest`'s twin).
 * `not_undone`: that entry is live (redone already, or never undone);
 * `not_next`: it is undone, but another undone entry comes first. Checked in
 * the redo's own transaction. Without `expectedId` this is the bare redo.
 */
export function redoNext(userId: number, expectedId?: number): RedoOutcome {
  const outcome = withTransaction((tx): RedoOutcome & { entry?: ParsedUndoEntry } => {
    const [parsed] = selectUndoEntries(userId, { undone: true, limit: 1 })
    if (expectedId !== undefined && parsed?.id !== expectedId) {
      const state = entryState(userId, expectedId)
      return {
        status: 'conflict',
        reason: state === 'gone' ? 'gone' : state === 'live' ? 'not_undone' : 'not_next',
        next_redoable_id: parsed?.id ?? null,
      }
    }
    if (!parsed) return { status: 'empty' }

    redoEntry(tx, parsed)
    return {
      status: 'redone',
      id: parsed.id,
      entry: parsed,
      result: {
        redone_action: parsed.action as RedoResult['redone_action'],
        description: parsed.description,
        tasks_affected: parsed.snapshots.length,
      },
    }
  })

  if (outcome.status !== 'redone') return outcome
  const { entry, ...done } = outcome
  afterUndoRedo(userId, [entry!], 'redo')
  return done
}

/**
 * Execute redo for the most recently undone action
 *
 * @param userId The user performing the redo
 * @returns The result of the redo operation, or null if nothing to redo
 */
export function executeRedo(userId: number): RedoResult | null {
  const outcome = redoNext(userId)
  return outcome.status === 'redone' ? outcome.result : null
}
