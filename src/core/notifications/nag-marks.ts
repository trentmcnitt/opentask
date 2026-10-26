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
 *    due minute, the first repeat is `nextNagAt(due)`, every later one S on.
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

/** The zone's UTC offset in minutes at an instant (0 for an unknown zone). */
function offsetMinutes(ms: number, timezone: string): number {
  const local = DateTime.fromMillis(ms, { zone: timezone })
  return local.isValid ? local.offset : 0
}

/** The whole-minute index of an instant (minutes since the epoch, floored). */
export function minuteIndex(at: Date | string | number): number {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : at.getTime()
  return Math.floor(ms / MINUTE_MS)
}

/**
 * When the repeat after a send at `last` goes: the local clock mark nearest
 * `last + I` (to the minute), a tie to the earlier mark. `last` is floored to
 * its minute first — the cron runs on the minute grid.
 */
export function nextNagAt(last: Date | string, intervalMinutes: number, timezone: string): Date {
  const grid = markGridMinutes(intervalMinutes)
  const target = minuteIndex(last) + intervalMinutes
  const offset = offsetMinutes(target * MINUTE_MS, timezone)
  const local = target + offset
  const down = Math.floor(local / grid) * grid
  const up = down + grid
  const mark = local - down <= up - local ? down : up
  return new Date((mark - offset) * MINUTE_MS)
}

/**
 * Whether the minute of `now` is a REPEAT of a nag whose first push was at
 * the minute `firstMinute` (a `minuteIndex`): the first repeat is
 * `nextNagAt(first)`, every later one a fixed step on. Stateless — the
 * overdue checker's rule. The first push itself is the caller's to decide.
 */
export function isRepeatMinute(
  firstMinute: number,
  intervalMinutes: number,
  now: Date,
  timezone: string,
): boolean {
  if (intervalMinutes <= 0) return false
  const firstRepeat = minuteIndex(
    nextNagAt(new Date(firstMinute * MINUTE_MS), intervalMinutes, timezone),
  )
  const since = minuteIndex(now) - firstRepeat
  return since >= 0 && since % markStepMinutes(intervalMinutes) === 0
}
