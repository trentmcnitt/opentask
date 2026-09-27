/**
 * The first day of the user's week — the one place a week boundary is computed.
 *
 * A per-user preference (`users.week_start`, Settings → "Week starts on"):
 * `'sunday'` (the default — US convention; Trent, 2026-09-27: "Saturday at
 * midnight is the changeover") or `'monday'` (ISO 8601). Before this existed
 * every week in the app was Luxon's ISO week, which starts Monday and has no
 * option to change it — so NOTHING may call `startOf('week')` / `endOf('week')`
 * for a user-facing week any more. Use `startOfWeek` below.
 *
 * Pure (no DB, no Node imports): shared by the server (period rollover, quota
 * prompts, quick take) and the client (Track panel "N days left", notch).
 *
 * ── Quota periods and a misaligned anchor ──────────────────────────────────
 *
 * A weekly quota's current period begins at `tasks.progress_period_start` (the
 * anchor) and normally ends `interval` weeks later. An anchor that is NOT on
 * one of the user's week-start boundaries — anchored under the old
 * Monday-only rule, or the user flipped the preference, or moved timezone so
 * the stored instant is no longer local midnight — ends instead at the NEXT
 * week-start boundary after it. That period is short (Mon → Sun is 6 days);
 * it closes like any other (met → completion, short → recorded only), and the
 * period after it starts on the boundary, so from then on the quota is aligned.
 *
 * INTERVAL > 1: the short period still ends at the next boundary (one week at
 * most), and the next period then runs the full `interval` weeks from it.
 * There is no "phase" to preserve — a 2-week quota's fortnight is simply
 * counted from wherever its aligned anchor lands.
 */
import { DateTime } from 'luxon'

export type WeekStart = 'sunday' | 'monday'

export const WEEK_START_DEFAULT: WeekStart = 'sunday'

export const WEEK_STARTS: readonly WeekStart[] = ['sunday', 'monday']

/** A stored/sent value as a WeekStart — anything unknown reads as the default. */
export function coerceWeekStart(value: unknown): WeekStart {
  return value === 'monday' || value === 'sunday' ? value : WEEK_START_DEFAULT
}

/** Luxon weekday (1 = Monday … 7 = Sunday) the week begins on. */
function startWeekday(weekStart: WeekStart): number {
  return weekStart === 'monday' ? 1 : 7
}

/**
 * Local midnight of the first day of the week containing `dt`, in `dt`'s zone.
 * Calendar arithmetic (`minus({ days })`), so a DST change inside the week
 * still lands on 00:00 local.
 */
export function startOfWeek(dt: DateTime, weekStart: WeekStart): DateTime {
  const back = (dt.weekday - startWeekday(weekStart) + 7) % 7
  return dt.startOf('day').minus({ days: back })
}

export type PeriodUnit = 'days' | 'weeks' | 'months' | 'years'

/**
 * The instant a quota period that began at `anchor` ends (exclusive).
 *
 * Everything but a week is plain calendar addition. A week whose anchor sits
 * on the user's boundary runs `interval` weeks; one that does not ends at the
 * next boundary (see the module doc).
 */
export function quotaPeriodEnd(
  anchor: DateTime,
  unit: PeriodUnit,
  interval: number,
  weekStart: WeekStart,
): DateTime {
  if (unit !== 'weeks') return anchor.plus({ [unit]: interval })
  const boundary = startOfWeek(anchor, weekStart)
  if (boundary.toMillis() === anchor.toMillis()) return anchor.plus({ weeks: interval })
  return boundary.plus({ weeks: 1 })
}
