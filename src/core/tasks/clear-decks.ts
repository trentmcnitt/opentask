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
 *     back on its occurrence (`due_at`, `original_due_at` := `occurrence_at`),
 *     as taking it off deck does — never left target-less;
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

/** Take them off deck and out of the queue. Returns what it cleared. */
export function clearDecks(userId: number, now: Date = new Date()): DeckedRow[] {
  const nowStr = now.toISOString()
  return withTransaction((tx) => {
    const found = findDecks(userId)
    // A repeating deck's target comes back on its occurrence (see the header).
    const undeck = tx.prepare(
      `UPDATE tasks
          SET on_deck_day = NULL,
              due_at = CASE WHEN rrule IS NOT NULL AND due_at IS NULL THEN occurrence_at ELSE due_at END,
              original_due_at = CASE WHEN rrule IS NOT NULL AND due_at IS NULL AND occurrence_at IS NOT NULL
                                     THEN occurrence_at ELSE original_due_at END,
              updated_at = ?
        WHERE id = ? AND on_deck_day IS NOT NULL`,
    )
    const unqueue = tx.prepare(
      `UPDATE tasks SET queued_at = NULL, try_tomorrow = 0, updated_at = ?
        WHERE id = ? AND queued_from_deck_day IS NOT NULL`,
    )
    for (const t of found) {
      const decked = t.on_deck_day !== null
      ;(decked ? undeck : unqueue).run(nowStr, t.id)
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
