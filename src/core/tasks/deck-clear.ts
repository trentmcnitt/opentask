/**
 * THE PICK-ONLY DECK CLEAR (On deck, 2026-10-20; red-team B1 — load-bearing;
 * docs/TASK-MODEL.md § On deck).
 *
 * Rule 1: a task carries a PICKED target or an on-deck day, never both. So a
 * write that leaves the task with a target the user picked — `resolveTarget`
 * answered `auto === false` with a `due_at` — clears `on_deck_day` in the SAME
 * write and undo snapshot. So does a write that makes the task something that
 * can't be on deck (a repeating task, a reminder, a quota: rule 6).
 *
 * What does NOT clear it: a deadline added or changed, or "Back to auto" — the
 * target they leave is the deadline's AUTOMATIC one, which a deck lives beside
 * ("the deadline protects regardless"). That is why this can't ride on
 * `stampTargetSet` (target-set.ts), which fires on ANY `due_at` or
 * `deadline_at` write, automatic targets included.
 *
 * WHO CALLS IT: `collectFieldChanges` (update, bulk edit, bulk snooze in every
 * form, snooze-overdue, the snooze endpoint, Today, the period moves) and AI
 * enrichment's `collectEnrichmentTarget`, judged on the RESULTING row. The
 * fixed-SQL writers (a completion advance, skip, put-back of an occurrence,
 * the stripped-target restore) write `DECK_CLEAR_SQL` in their own
 * statements. The guard (`tests/behavioral/od-deck.test.ts`, OD-G01/G02)
 * fails when a file that writes `due_at` neither imports this module nor is
 * on its short exempt list.
 *
 * Done does NOT clear a deck: a put-back brings it back with it, and a deck
 * day that has passed by then is stripped at the next rollover.
 */

import type { Task } from '@/types'
import type { CollectedWrite } from './target-set'

/** The deck clear as a fixed SQL fragment, for the writers whose SQL is a fixed statement. */
export const DECK_CLEAR_SQL = 'on_deck_day = NULL'

/** What a write leaves on the row, for the deck clear. */
export interface DeckClearAfter {
  /** The target the write leaves. */
  dueAt: string | null
  /** That target is the deadline's automatic one (`target_auto`). */
  auto: boolean
  /** The rule the write leaves. */
  rrule: string | null
  isReminder: boolean
  isTracked: boolean
}

/** Whether a write leaving `after` must clear the task's deck (see the module doc). */
export function deckClearedBy(task: Pick<Task, 'on_deck_day'>, after: DeckClearAfter): boolean {
  if (!task.on_deck_day) return false
  const picked = after.dueAt !== null && !after.auto
  return picked || after.rrule !== null || after.isReminder || after.isTracked
}

/**
 * Add the clear to a write being collected clause by clause, when it applies.
 * Pushes the clause, the field, and — when the write keeps snapshot states —
 * the before/after values, so undo puts the deck back. Returns whether it did.
 */
export function collectDeckClear(
  write: CollectedWrite,
  task: Pick<Task, 'on_deck_day'>,
  after: DeckClearAfter,
): boolean {
  if (!deckClearedBy(task, after) || write.fieldsChanged.includes('on_deck_day')) return false
  write.setClauses.push(DECK_CLEAR_SQL)
  write.fieldsChanged.push('on_deck_day')
  if (write.beforeState) write.beforeState.on_deck_day = task.on_deck_day
  if (write.afterState) write.afterState.on_deck_day = null
  return true
}
