/**
 * THE PICK-ONLY DECK CLEAR (On deck, 2026-10-20; red-team B1 — load-bearing;
 * docs/TASK-MODEL.md § On deck).
 *
 * Rule 1: a task carries a PICKED target or an on-deck day, never both. So a
 * write that leaves the task with a target the user picked — `resolveTarget`
 * answered `auto === false` with a `due_at` — clears `on_deck_day` in the SAME
 * write and undo snapshot. So does a write that makes the task something that
 * can't be on deck (a reminder, a quota: rule 6).
 *
 * A REPEATING task can be on deck (2026-10-20), so a rule on the row clears
 * nothing by itself — any edit of a decked repeating task would otherwise
 * take it off. Its deck goes when the write leaves a picked `due_at` (Today,
 * any snooze). A SCHEDULE change (a new rule, offsets, mode, anchor) keeps it
 * since PR 4a (2026-10-22): the decked occurrence is the user's, so no target
 * is computed (`occurrenceIsPersonal`) — unless the deadline it leaves
 * outranks the deck (A1, below). A PATCH sending a rule AND a deck day is
 * refused outright (`prepareDeck`).
 *
 * What does NOT clear it: a deadline added or changed — the task it leaves has
 * no target (the deadlines page, 2026-10-22: its safety net holds it, deck or
 * not) — UNLESS that deadline has passed or now falls BEFORE the deck's day
 * (A1, `deckRefusal`): then the deadline wins and the deck goes in the same
 * write. (With the switch off there are no decks at all.) That is why this can't ride on
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
import { deadlinePlace, deckRefusal, type TargetContext } from '@/lib/task-segments'
import type { CollectedWrite } from './target-set'
import { rolloverTimeForUser } from './rollover-time'

/** The deck clear as a fixed SQL fragment, for the writers whose SQL is a fixed statement. */
export const DECK_CLEAR_SQL = 'on_deck_day = NULL'

/** What a write leaves on the row, for the deck clear. */
export interface DeckClearAfter {
  /** The target the write leaves. */
  dueAt: string | null
  /** That target is the deadline's automatic one (`target_auto`). */
  auto: boolean
  /** The rule the write leaves (a repeating deck is judged by its deadline's day, A1). */
  rrule: string | null
  isReminder: boolean
  isTracked: boolean
  /**
   * The deadline the write leaves, when the caller can say (A1, strict): a
   * deadline added or moved on a decked task re-runs the deck check — if the
   * new automatic target has arrived, or its day is on or before the deck's,
   * THE DEADLINE WINS and the deck goes. Decks never nag.
   */
  deadline?: {
    at: string | null
    changed: boolean
    ctx: TargetContext
    now: Date
    /** The owner's rollover time, for a repeating task (`deckRolloverTime`). */
    rolloverTime?: string | null
  }
}

/** Whether a write leaving `after` must clear the task's deck (see the module doc). */
export function deckClearedBy(task: Pick<Task, 'on_deck_day'>, after: DeckClearAfter): boolean {
  if (!task.on_deck_day) return false
  const picked = after.dueAt !== null && !after.auto
  if (picked || after.isReminder || after.isTracked) return true
  return deadlineOutranksDeck(task.on_deck_day, after)
}

/** A1 strict: the deadline this write added or moved now reminds on or before the deck day. */
function deadlineOutranksDeck(day: string, after: DeckClearAfter): boolean {
  const d = after.deadline
  if (!d || !d.changed || d.at === null) return false
  const left = {
    due_at: after.dueAt,
    deadline_at: d.at,
    target_auto: after.auto,
    rrule: after.rrule,
  }
  return deckRefusal(left, day, d.ctx, d.now, d.rolloverTime ?? null) !== null
}

/**
 * The owner's rollover time the deck check needs (`repeatingDeadlineDay`: a
 * deadline before the rollover counts as the evening before). Since the
 * deadlines page (2026-10-22) a one-off is judged by its deadline's OpenTask
 * day too, so every task reads it.
 */
export function deckRolloverTime(task: Pick<Task, 'user_id'>): string | null {
  return rolloverTimeForUser(task.user_id)
}

/**
 * Whether the DEADLINES PAGE holds the task once a deck write leaves it — no
 * target (a deck drops a picked one), the deck day, the resulting deadline —
 * `deadlinePlace` on that row (Trent, 2026-10-22: a decked page row STAYS on
 * the page, waiting, showing its deck day). Then the deck does not stamp it
 * considered (A7's stamp, `collect-field-changes`): seeing it is still its own
 * tap. A deck for today outside the safety net is the On deck section's, and
 * one before the lead day its Upcoming row's — both stamp as before.
 */
export function deckKeepsPageRow(
  task: Task,
  day: string,
  deadlineAt: string | null,
  timezone: string,
  now: Date,
): boolean {
  if (!deadlineAt || (task.rrule && task.repeat_anchor !== 'deadline')) return false
  const after = { ...task, deadline_at: deadlineAt, due_at: null, on_deck_day: day }
  return deadlinePlace(after, timezone, now, deckRolloverTime(task))?.kind === 'page'
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
