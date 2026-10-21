/**
 * CLEAR DECKS — On deck's rollback (2026-10-20; docs/TASK-MODEL.md § On deck;
 * the CLI is `scripts/clear-decks.ts`).
 *
 * For one user:
 *  1. every open task ON DECK is taken off deck (`on_deck_day` → NULL).
 *     Nothing else changes for a one-off: a deck never carries a picked
 *     target, so there is no target to restore, and a deadline task keeps
 *     its automatic target. It goes back to where an untargeted task sits
 *     (its horizon segment). A REPEATING deck (2026-10-20) gets its target
 *     back — its occurrence's own (`due_at`, `original_due_at` :=
 *     `occurrenceDates(occurrence_at).targetAt`), as taking it off deck does —
 *     never left target-less;
 *  2. every open task the rollover sent to the queue FROM a deck
 *     (`queued_from_deck_day` set) still queued leaves the queue
 *     (`queued_at`, `try_tomorrow` → cleared; `queued_from_deck_day` kept as
 *     history), so a rollback leaves no deck-made row parked out of sight.
 *
 * Like the stripped-target restore, it is an operator tool, not a user
 * action: one activity row per task, no undo entry. Done, trashed and
 * archived rows are left alone.
 */
import { getDb, withTransaction } from '@/core/db'
import { logActivity } from '@/core/activity'
import { occurrenceDates, type RepeatSchedule } from '@/lib/task-segments'

export interface DeckedRow {
  id: number
  /** On deck for this day (1), or null for a queued deck strip (2). */
  on_deck_day: string | null
  /** The deck day a queued strip remembers (2), else null. */
  queued_from_deck_day: string | null
  queued_at: string | null
}

const OPEN = 'done = 0 AND deleted_at IS NULL AND archived_at IS NULL'

/** The open tasks a clear would touch: on deck, or queued from a deck. */
export function findDecks(userId: number): DeckedRow[] {
  return getDb()
    .prepare(
      `SELECT id, on_deck_day,
              CASE WHEN on_deck_day IS NULL THEN queued_from_deck_day END AS queued_from_deck_day,
              CASE WHEN on_deck_day IS NULL THEN queued_at END AS queued_at
         FROM tasks
        WHERE user_id = ? AND ${OPEN}
          AND (on_deck_day IS NOT NULL
               OR (queued_from_deck_day IS NOT NULL AND queued_at IS NOT NULL))
        ORDER BY id`,
    )
    .all(userId) as DeckedRow[]
}

/**
 * The target a REPEATING deck gets back: its occurrence's own target
 * (`occurrenceDates` — on a deadline-anchored repeat, before its deadline; as
 * `collectRepeatingUndeck` does) — or null (a one-off, a row that still has a
 * target, or one with no occurrence to go back to).
 */
function restoredTarget(id: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT t.rrule, t.repeat_anchor, t.target_days_before, t.target_time, t.due_at,
              t.occurrence_at, u.timezone
         FROM tasks t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
    )
    .get(id) as
    | (RepeatSchedule & { due_at: string | null; occurrence_at: string | null; timezone: string })
    | undefined
  if (!row || !row.rrule || row.due_at !== null || !row.occurrence_at) return null
  return occurrenceDates(row, row.occurrence_at, row.timezone).targetAt
}

/** Take them off deck and out of the queue. Returns what it cleared. */
export function clearDecks(userId: number, now: Date = new Date()): DeckedRow[] {
  const nowStr = now.toISOString()
  return withTransaction((tx) => {
    const found = findDecks(userId)
    // A repeating deck's target comes back: its occurrence's own (see the
    // header; `restoredTarget`). NULL leaves a one-off's alone.
    const undeckStmt = tx.prepare(
      `UPDATE tasks
          SET on_deck_day = NULL, due_at = COALESCE(?, due_at),
              original_due_at = COALESCE(?, original_due_at), updated_at = ?
        WHERE id = ? AND on_deck_day IS NOT NULL`,
    )
    const undeck = (id: number) => {
      const restored = restoredTarget(id)
      undeckStmt.run(restored, restored, nowStr, id)
    }
    const unqueue = tx.prepare(
      `UPDATE tasks SET queued_at = NULL, try_tomorrow = 0, updated_at = ?
        WHERE id = ? AND queued_from_deck_day IS NOT NULL`,
    )
    for (const t of found) {
      const decked = t.on_deck_day !== null
      if (decked) undeck(t.id)
      else unqueue.run(nowStr, t.id)
      logActivity({
        userId,
        taskId: t.id,
        action: 'edit',
        fields: decked ? ['on_deck_day'] : ['queued_at', 'try_tomorrow'],
        before: decked
          ? { id: t.id, on_deck_day: t.on_deck_day }
          : { id: t.id, queued_at: t.queued_at },
        after: decked ? { id: t.id, on_deck_day: null } : { id: t.id, queued_at: null },
        metadata: { clear_decks: true },
      })
    }
    return found
  })
}
