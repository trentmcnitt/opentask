import { DateTime } from 'luxon'
import { getDb } from '@/core/db'

export const TZ = 'America/Chicago'

/** Chicago wall-clock → UTC ISO (what the API takes). */
export function iso(local: string): string {
  return DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
}

/** Backdate a column the API always stamps with now (a past completion, an old task). */
export function backdate(
  id: number,
  column: 'target_set_at' | 'created_at' | 'last_completed_at',
  local: string,
): void {
  getDb().prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(iso(local), id)
}

/**
 * A timeline that is `line` on each of `days` and quiet otherwise — the shape
 * of every reference row (heads-up days, then over target from the target day).
 */
export function headsUps(days: string[], line: string): Record<string, string> {
  return Object.fromEntries(days.map((d) => [d, line]))
}

/**
 * Upcoming's days by SECTION (2026-10-25, the Upcoming split): `later` on
 * each Later day, `tomorrow` on each Tomorrow day (the day before the anchor).
 * Written from the rule — Tomorrow = A − 1 when the wait is 2+; Later =
 * max(A − lead, set day + 1) when that is ≤ A − 2 — never from the output.
 */
export function upcoming(days: { later?: string[]; tomorrow?: string[] }): Record<string, string> {
  return { ...headsUps(days.later ?? [], 'later'), ...headsUps(days.tomorrow ?? [], 'tomorrow') }
}
