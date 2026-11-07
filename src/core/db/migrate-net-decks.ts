/**
 * DATA STEP: DECKS INTO A SAFETY NET (2026-11-07, Trent: "Why did it even let
 * me put it on deck for tomorrow if it must be targeted?").
 *
 * Since 2026-11-07 a deadline task the deadlines page can hold (a one-off, or
 * a deadline-anchored repeat — `deckMeetsTheNet`) is decked at most on D−2,
 * never into its safety net (`deckRefusal`'s `safety_net` / `after_safety_net`).
 * Decks made before that can sit on D−1 or D. On those days the net holds the
 * task on the deadlines page whatever the deck says, so the deck counts for
 * nothing — it only shows "On deck tomorrow" / "On deck Sun" words that read
 * as a plan (#33391, the Urban Air waiver link). This clears them:
 * `on_deck_day` → NULL on every OPEN ordinary task the page can hold whose
 * deck day is past its limit (D−2, `lastDeferDay`, in the owner's zone and
 * OpenTask day). Nothing else changes — no target is set: the page holds the
 * task, waiting, as it does any target-less deadline task in its net.
 *
 * Not an undo entry (like every data step here): it corrects state a rule
 * now forbids. IDEMPOTENT: a cleared row no longer matches; a deck the new
 * rule allows (on or before D−2) is never touched. Runs in the server only,
 * with the task-queue switch on (decks exist only then; `runDeadlineSteps`).
 * Returns the ids it cleared (no titles), for the startup log.
 */

import type Database from 'better-sqlite3'
import { dayStartTimeOf } from '@/lib/anchor-times'
import { lastDeferDay } from '@/lib/task-segments'

interface DeckRow {
  id: number
  user_id: number
  deadline_at: string
  on_deck_day: string
  timezone: string | null
  day_start_time: string | null
  day_start_slot_id: number | null
}

export function clearNetDecks(db: Database.Database, now: Date = new Date()): number[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT t.id, t.user_id, t.deadline_at, t.on_deck_day,
                u.timezone, u.day_start_time, u.day_start_slot_id
           FROM tasks t JOIN users u ON u.id = t.user_id
          WHERE t.on_deck_day IS NOT NULL AND t.deadline_at IS NOT NULL
            AND (t.rrule IS NULL OR t.repeat_anchor = 'deadline')
            AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
            AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1
          ORDER BY t.id`,
      )
      .all() as DeckRow[]
    const slots = db.prepare('SELECT id, start_time FROM time_slots WHERE user_id = ?')
    const clear = db.prepare('UPDATE tasks SET on_deck_day = NULL, updated_at = ? WHERE id = ?')
    const nowStr = now.toISOString()
    const cleared: number[] = []
    for (const row of rows) {
      const tz = row.timezone || 'UTC'
      const rollover = dayStartTimeOf(
        row,
        slots.all(row.user_id) as { id: number; start_time: string }[],
      )
      if (row.on_deck_day > lastDeferDay(row.deadline_at, tz, rollover)) {
        clear.run(nowStr, row.id)
        cleared.push(row.id)
      }
    }
    return cleared
  })()
}
