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
 * own banner), `reminder-<taskId>` (reminder-nags.ts, one per Medium+
 * reminder, 2026-10-26), `prompt-<prompt_key>` (prompt-nags.ts, one per
 * Medium+ quota's prompt per OpenTask day — the key carries its date, Push
 * PR 4).
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

/**
 * Whether a nag last sent at `last` (null: never) is due at `now`: its next
 * mark has come — or, with a `since` floor, `last` is from before it (a named
 * reminder push restarts at its period's open each day, whatever the rung:
 * reminder-nags.ts).
 */
export function dueAfter(
  last: string | null,
  intervalMinutes: number,
  now: Date,
  timezone: string,
  since?: Date,
): boolean {
  if (last === null) return true
  if (since && new Date(last).getTime() < since.getTime()) return true
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

/**
 * Whether `key` may send for `userId` at `now`: the mark after its last send
 * has come, or (with `since`) its last send is from before `since`.
 */
export function nagSendDue(
  userId: number,
  key: string,
  intervalMinutes: number,
  now: Date,
  timezone: string,
  since?: Date,
): boolean {
  return dueAfter(lastSent(userId, key), intervalMinutes, now, timezone, since)
}

/**
 * CLAIM a send: true when this call may send, recording `now` as the last
 * send. A second claim for the same moment — a double tick — loses. `since`
 * as in `nagSendDue`.
 */
export function claimNagSend(
  userId: number,
  key: string,
  intervalMinutes: number,
  now: Date,
  timezone: string,
  since?: Date,
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
  if (!dueAfter(last, intervalMinutes, now, timezone, since)) return false
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

/**
 * CLAIM A TICK MINUTE for one sender and user (tick.ts): true once per
 * minute, false for any later claim of the same minute — another run of the
 * same minute, in this process or another (the startup check, a deploy's
 * restart overlapping the old process's last tick). Persisted in `nag_sends`
 * under the sender's `tick-…` key, a compare-and-swap like the nags', so a
 * minute's pushes go out once whichever process gets there first. Equality,
 * not order: a clock moved back (the test clock) claims afresh.
 */
export function claimTickMinute(userId: number, key: string, now: Date): boolean {
  const db = getDb()
  const last = lastSent(userId, key)
  const at = new Date(minuteIndex(now) * 60_000).toISOString()
  if (last === null) {
    return (
      db
        .prepare('INSERT OR IGNORE INTO nag_sends (user_id, key, last_sent_at) VALUES (?, ?, ?)')
        .run(userId, key, at).changes === 1
    )
  }
  if (minuteIndex(last) === minuteIndex(now)) return false
  return (
    db
      .prepare(
        'UPDATE nag_sends SET last_sent_at = ? WHERE user_id = ? AND key = ? AND last_sent_at = ?',
      )
      .run(at, userId, key, last).changes === 1
  )
}
