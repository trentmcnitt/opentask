/**
 * CLOCK MARKS — where every REPEAT of a nag lands (Trent, 2026-10-26; plan
 * "named pushes and marks" Part B).
 *
 * A first push is exact: a period at 9:15 pushes at 9:15, a target deferred to
 * 10:07 fires at 10:07, a deadlines-page row that starts waiting at 03:00 nags
 * at 03:00. Only the REPEATS snap to the clock, so they read as "the top of
 * the hour", "the half hour", not "every 60 minutes from whenever":
 *
 *  - THE GRID. G = 60 for an interval I of 60 or more; below that, the largest
 *    divisor of 60 that is ≤ I (I 5 → 5, 10 → 10, 15 → 15, 30 → 30, 45 → 30,
 *    7 → 6). Marks are the user's LOCAL wall-clock minutes divisible by G, so
 *    G = 60 is the top of the local hour in a half-hour zone too.
 *  - THE NEXT SEND is the mark NEAREST `last + I`; a tie goes to the EARLIER
 *    mark. So from a 16:30 push at I = 60 the target 17:30 sits halfway
 *    between 17:00 and 18:00, and the nag comes at 17:00; from 20:15 it comes
 *    at 21:00; from 8:15 at I = 120 at 10:00.
 *  - THE GAP that gives, between one send and the next (whole minutes):
 *      I   5 →   3–7      I  60 →  30–89     I 240 → 210–269
 *      I  10 →   5–14     I 120 →  90–149    I 480 → 450–509
 *      I  30 →  15–44
 *    Never under half the interval (G ≤ I keeps the nearest mark within G/2
 *    of the target); tests/behavioral/dn-nag-marks.test.ts pins it.
 *  - ON A MARK, THE STEP IS FIXED. From a send already on the grid the next
 *    one is `last + S`, S = I rounded to the nearest multiple of G (tie
 *    earlier): 60 → 60, 90 → 60, 150 → 120, 7 → 6. That is what keeps the
 *    overdue checker stateless (`isRepeatMinute`): its first push is at the
 *    due minute, the first repeat is `nextNagAt(due)`, the k-th one the mark
 *    nearest `first repeat + k·S`.
 *  - EVERY MARK IN ITS OWN OFFSET (review of #362). A candidate mark is judged
 *    in the UTC offset that holds AT that mark, not at the target: across a
 *    DST change that isn't a whole hour (Australia/Lord_Howe shifts 30
 *    minutes) a fixed UTC step would leave every later repeat at :30 local.
 *    Snapping each step's target to the nearest real local mark keeps them on
 *    :00. A local time the change skips is no mark; one it repeats is a mark
 *    twice (both instants). In whole-hour zones (America/Chicago) the target
 *    is always a mark already, so nothing moves: repeats keep their real-time
 *    spacing through spring forward and fall back.
 *
 * Who reads it: the overdue checker (stateless, from the due time) and every
 * `nag_sends`-paced nag — the slot nag and the deadlines nag (nag-sends.ts,
 * from the stored last send). Pure; no database.
 */

import { DateTime } from 'luxon'

const MINUTE_MS = 60_000

/** Every divisor of 60, largest first. */
const DIVISORS_OF_60 = [60, 30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1]

/** The mark grid for an interval (minutes): 60 at 60 and over, else the largest divisor of 60 ≤ I. */
export function markGridMinutes(intervalMinutes: number): number {
  if (intervalMinutes >= 60) return 60
  return DIVISORS_OF_60.find((d) => d <= intervalMinutes) ?? 1
}

/** The fixed step between two repeats once on the grid: I to the nearest multiple of G, tie earlier. */
export function markStepMinutes(intervalMinutes: number): number {
  const grid = markGridMinutes(intervalMinutes)
  const below = Math.floor(intervalMinutes / grid) * grid
  const step = intervalMinutes - below <= below + grid - intervalMinutes ? below : below + grid
  return Math.max(grid, step)
}

/** The zone's UTC offset in minutes at a whole minute (0 for an unknown zone). */
function offsetAt(minute: number, timezone: string): number {
  const local = DateTime.fromMillis(minute * MINUTE_MS, { zone: timezone })
  return local.isValid ? local.offset : 0
}

/** The whole-minute index of an instant (minutes since the epoch, floored). */
export function minuteIndex(at: Date | string | number): number {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : at.getTime()
  return Math.floor(ms / MINUTE_MS)
}

/**
 * The real minute nearest `target` (a `minuteIndex`) whose LOCAL time is a
 * multiple of `grid`, a tie to the earlier one. Each candidate is judged in
 * the offset that holds at it: the offsets in force within a grid either
 * side of the target are tried, and a candidate counts only if its own
 * offset is the one it was built with (so a skipped local time is no mark).
 */
function nearestMark(target: number, grid: number, timezone: string): number {
  const offsets = new Set([
    offsetAt(target - grid, timezone),
    offsetAt(target, timezone),
    offsetAt(target + grid, timezone),
  ])
  if (offsets.size === 1) {
    // No offset change within a grid either side: the plain nearest mark.
    const [offset] = offsets
    const local = target + offset
    const down = Math.floor(local / grid) * grid
    return (local - down <= down + grid - local ? down : down + grid) - offset
  }
  let best: number | null = null
  for (const offset of offsets) {
    const down = Math.floor((target + offset) / grid) * grid
    for (const localMark of [down - grid, down, down + grid, down + 2 * grid]) {
      const minute = localMark - offset
      if (offsetAt(minute, timezone) !== offset) continue
      const d = Math.abs(minute - target)
      const bestD = best === null ? Infinity : Math.abs(best - target)
      if (d < bestD || (d === bestD && minute < best!)) best = minute
    }
  }
  // Unreachable for a real zone (every grid window holds a mark); a safe fallback.
  return best ?? target
}

/**
 * When the repeat after a send at `last` goes: the local clock mark nearest
 * `last + I` (to the minute), a tie to the earlier mark, judged in the offset
 * at the mark. `last` is floored to its minute first — the cron runs on the
 * minute grid.
 */
export function nextNagAt(last: Date | string, intervalMinutes: number, timezone: string): Date {
  const target = minuteIndex(last) + intervalMinutes
  return new Date(nearestMark(target, markGridMinutes(intervalMinutes), timezone) * MINUTE_MS)
}

/**
 * Whether the minute of `now` is a REPEAT of a nag whose first push was at
 * the minute `firstMinute` (a `minuteIndex`): the first repeat is
 * `nextNagAt(first)`, the k-th the mark nearest `first repeat + k·S`.
 * Stateless — the overdue checker's rule. The first push itself is the
 * caller's to decide. In a whole-hour zone the k-th repeat is exactly
 * `first repeat + k·S`.
 */
export function isRepeatMinute(
  firstMinute: number,
  intervalMinutes: number,
  now: Date,
  timezone: string,
): boolean {
  if (intervalMinutes <= 0) return false
  const grid = markGridMinutes(intervalMinutes)
  const step = markStepMinutes(intervalMinutes)
  const firstRepeat = nearestMark(firstMinute + intervalMinutes, grid, timezone)
  const minute = minuteIndex(now)
  if (minute < firstRepeat) return false
  // A snapped repeat sits within a grid of its step's target (G ≤ S), so
  // only the steps either side of the nearest can land on this minute.
  const k = Math.round((minute - firstRepeat) / step)
  for (const j of [k - 1, k, k + 1]) {
    if (j < 0) continue
    if (nearestMark(firstRepeat + j * step, grid, timezone) === minute) return true
  }
  return false
}
