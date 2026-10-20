/**
 * CLEAR DECKS — On deck's rollback (2026-10-20; docs/TASK-MODEL.md § On deck;
 * the CLI is `scripts/clear-decks.ts`).
 *
 * Takes every open task of one user off deck (`on_deck_day` → NULL). Nothing
 * else changes: a deck never carries a picked target, so there is no target
 * to restore, and a deadline task keeps its automatic target. Each task goes
 * back to where an untargeted task sits (its horizon segment). Tasks the
 * rollover already sent to the queue from a deck stay queued, like any
 * stripped task (their `queued_from_deck_day` is kept).
 *
 * Like the stripped-target restore, it is an operator tool, not a user
 * action: one activity row per task, no undo entry. Done, trashed and
 * archived rows are left alone.
 */
import { getDb, withTransaction } from '@/core/db'
import { logActivity } from '@/core/activity'

export interface DeckedRow {
  id: number
  on_deck_day: string
}

/** The open tasks a clear would touch. */
export function findDecks(userId: number): DeckedRow[] {
  return getDb()
    .prepare(
      `SELECT id, on_deck_day FROM tasks
        WHERE user_id = ? AND on_deck_day IS NOT NULL
          AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
        ORDER BY id`,
    )
    .all(userId) as DeckedRow[]
}

/** Take them off deck. Returns what it cleared. */
export function clearDecks(userId: number, now: Date = new Date()): DeckedRow[] {
  const nowStr = now.toISOString()
  return withTransaction((tx) => {
    const found = findDecks(userId)
    const update = tx.prepare(
      'UPDATE tasks SET on_deck_day = NULL, updated_at = ? WHERE id = ? AND on_deck_day IS NOT NULL',
    )
    for (const t of found) {
      update.run(nowStr, t.id)
      logActivity({
        userId,
        taskId: t.id,
        action: 'edit',
        fields: ['on_deck_day'],
        before: { id: t.id, on_deck_day: t.on_deck_day },
        after: { id: t.id, on_deck_day: null },
        metadata: { clear_decks: true },
      })
    }
    return found
  })
}
