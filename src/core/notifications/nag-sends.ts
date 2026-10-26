/**
 * `nag_sends` — WHEN A NAG LAST WENT OUT, per user and source (nag-map fix #5,
 * 2026-10-22). A nag repeats on the CLOCK MARK nearest its last send plus its
 * interval (nag-marks.ts; Trent 2026-10-26: every repeat lands on a mark, the
 * first push is exact). Restart-safe (the state is the row, read fresh each
 * tick), a double tick sends once (the claim is a compare-and-swap on the
 * value read), and after downtime the first tick sends once.
 *
 * Keys: `deadlines-page` (deadline-nags.ts), `slot-nag` (slot-nags.ts — the
 * slot-open push stamps it too, so the nag waits for the mark after a slot's
 * own banner).
 *
 * Several rungs at once (the slot nag's waiting items, the deadlines page's
 * rows): the PACE is the rung whose next mark comes FIRST (`nagPace`). That
 * is "the shortest interval wins" made exact for marks: a shorter interval
 * does not always land sooner (from 10:07, I 15 → 10:15 but I 10 → 10:20).
 */

import { getDb } from '@/core/db'
import { minuteIndex, nextNagAt } from '@/core/notifications/nag-marks'

/** The slot nag's key (slot-nags.ts; stamped by the slot-open push in slot-reminders.ts). */
export const SLOT_NAG_KEY = 'slot-nag'

function lastSent(userId: number, key: string): string | null {
  const row = getDb()
    .prepare('SELECT last_sent_at FROM nag_sends WHERE user_id = ? AND key = ?')
    .get(userId, key) as { last_sent_at: string } | undefined
  return row?.last_sent_at ?? null
}

/** Whether a nag last sent at `last` (null: never) is due at `now`: its next mark has come. */
function dueAfter(
  last: string | null,
  intervalMinutes: number,
  now: Date,
  timezone: string,
): boolean {
  if (last === null) return true
  return minuteIndex(now) >= minuteIndex(nextNagAt(last, intervalMinutes, timezone))
}

/**
 * Of several rungs (minutes), the one whose next mark after the last send of
 * `key` comes first — a tie to the shorter — or null for none. Never sent:
 * the shortest (every rung is due at once).
 */
export function nagPace(
  userId: number,
  key: string,
  intervals: number[],
  timezone: string,
): number | null {
  if (intervals.length === 0) return null
  const last = lastSent(userId, key)
  if (last === null) return Math.min(...intervals)
  let best: { interval: number; mark: number } | null = null
  for (const interval of intervals) {
    const mark = minuteIndex(nextNagAt(last, interval, timezone))
    if (!best || mark < best.mark || (mark === best.mark && interval < best.interval)) {
      best = { interval, mark }
    }
  }
  return best!.interval
}

/** Whether `key` may send for `userId` at `now`: the mark after its last send has come. */
export function nagSendDue(
  userId: number,
  key: string,
  intervalMinutes: number,
  now: Date,
  timezone: string,
): boolean {
  return dueAfter(lastSent(userId, key), intervalMinutes, now, timezone)
}

/**
 * CLAIM a send: true when this call may send, recording `now` as the last
 * send. A second claim for the same moment — a double tick — loses.
 */
export function claimNagSend(
  userId: number,
  key: string,
  intervalMinutes: number,
  now: Date,
  timezone: string,
): boolean {
  const db = getDb()
  const last = lastSent(userId, key)
  const at = now.toISOString()
  if (last === null) {
    return (
      db
        .prepare('INSERT OR IGNORE INTO nag_sends (user_id, key, last_sent_at) VALUES (?, ?, ?)')
        .run(userId, key, at).changes === 1
    )
  }
  if (!dueAfter(last, intervalMinutes, now, timezone)) return false
  return (
    db
      .prepare(
        'UPDATE nag_sends SET last_sent_at = ? WHERE user_id = ? AND key = ? AND last_sent_at = ?',
      )
      .run(at, userId, key, last).changes === 1
  )
}

/** Record a send that happened anyway (a slot's own push), so the nag waits from it. */
export function stampNagSend(userId: number, key: string, now: Date): void {
  getDb()
    .prepare(
      `INSERT INTO nag_sends (user_id, key, last_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
    )
    .run(userId, key, now.toISOString())
}
