/**
 * `nag_sends` — WHEN A NAG LAST WENT OUT, per user and source (nag-map fix #5,
 * 2026-10-22). A nag sends when the whole minutes since its last send reach
 * its interval (the nag ladder's). Restart-safe (the state is the row, read
 * fresh each tick), a double tick sends once (the claim is a compare-and-swap
 * on the value read), and after downtime the first tick sends once.
 *
 * Keys: `deadlines-page` (deadline-nags.ts), `slot-nag` (slot-nags.ts — the
 * slot-open push stamps it too, so the nag waits a full interval after a
 * slot's own banner).
 */

import { getDb } from '@/core/db'

/** The slot nag's key (slot-nags.ts; stamped by the slot-open push in slot-reminders.ts). */
export const SLOT_NAG_KEY = 'slot-nag'

/** Whole minutes from `from` (ISO) to `to`, on the minute grid the cron runs on. */
function minutesBetween(from: string, to: Date): number {
  return Math.floor(to.getTime() / 60000) - Math.floor(Date.parse(from) / 60000)
}

function lastSent(userId: number, key: string): string | null {
  const row = getDb()
    .prepare('SELECT last_sent_at FROM nag_sends WHERE user_id = ? AND key = ?')
    .get(userId, key) as { last_sent_at: string } | undefined
  return row?.last_sent_at ?? null
}

/** Whether `key` may send for `userId` at `now`, `intervalMinutes` after its last send. */
export function nagSendDue(
  userId: number,
  key: string,
  intervalMinutes: number,
  now: Date,
): boolean {
  const last = lastSent(userId, key)
  return last === null || minutesBetween(last, now) >= intervalMinutes
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
  if (minutesBetween(last, now) < intervalMinutes) return false
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
