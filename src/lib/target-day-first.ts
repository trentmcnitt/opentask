/**
 * THE TARGET'S FIRST TIME ON ITS DAY (`target_day_first_at`, Trent
 * 2026-10-29): the target as it was when it first landed on its current
 * OpenTask day, so a row can say "Today 2:00 PM · was 9:00 AM" — targeted at
 * 9:00, deferred to 2:00 — and nothing for a task targeted at 2:00 from the
 * start. `original_due_at` can't say it: that is the first target EVER (Tue 9
 * → Wed 9 → Wed 1 PM keeps Tue 9; the day's first is Wed 9).
 *
 * The rules, for every move of a target (`nextTargetDayFirst`):
 * - a target where there was none: the new target;
 * - a move to another OpenTask day: the new target;
 * - a move within the same OpenTask day: kept;
 * - no target (Remove target, the queue's strip): none.
 * A repeating task's done or skip sets it to the next occurrence's target
 * (written beside `original_due_at` there). "Back to auto" follows the
 * automatic target like any move.
 *
 * NORMALISED ON READ (`effectiveTargetDayFirst`): a stored value on another
 * OpenTask day than the target is stale — a write path that moved the target
 * across days without writing the column — and reads as the target itself.
 * So a path that misses the column can only drop the "was", never show a
 * wrong one. Days are the owner's OpenTask days (`openTaskDayOf`, their day
 * start): a 2:30 AM moment with a 3:00 AM start is the day before.
 *
 * Pure: the timezone and the day start come in.
 */
import { formatTimeInTimezone } from '@/lib/format-date'
import { openTaskDayOf } from '@/lib/opentask-day'

const dayOf = (iso: string, timezone: string, dayStart: string) =>
  openTaskDayOf(new Date(iso), timezone, dayStart)

/** The stored value as it reads: itself on the target's day, else the target. */
export function effectiveTargetDayFirst(
  first: string | null,
  dueAt: string | null,
  timezone: string,
  dayStart: string,
): string | null {
  if (dueAt === null) return null
  if (first === null) return dueAt
  return dayOf(first, timezone, dayStart) === dayOf(dueAt, timezone, dayStart) ? first : dueAt
}

/**
 * RULE TGT-DAY-FIRST: target_day_first_at is the target as it first landed on its current OpenTask
 *   day. A new target, or a move to another day, resets it, and a move within the same day keeps
 *   it. A stored value from another day reads as the target itself. The lean row shows 'was <time>'
 *   only when the day matches and the time differs.
 * Why: original_due_at is the first target ever and cannot say the day's first; a write that misses
 *   the column can only drop the "was", never show a wrong one.
 * Ruling: Trent, 2026-10-29 (src/lib/target-day-first.ts:2).
 */
/** The value a move of the target from `oldDue` to `newDue` leaves. */
export function nextTargetDayFirst(
  oldDue: string | null,
  oldFirst: string | null,
  newDue: string | null,
  timezone: string,
  dayStart: string,
): string | null {
  if (newDue === null) return null
  if (oldDue === null) return newDue
  if (dayOf(oldDue, timezone, dayStart) !== dayOf(newDue, timezone, dayStart)) return newDue
  return effectiveTargetDayFirst(oldFirst, oldDue, timezone, dayStart)
}

/**
 * The row's "was 9:00 AM" time: the day's first target time, when the target
 * is on that day and has moved from it; else null. Reads the normalised
 * value the server serves, re-checking the day for a value read off-day.
 */
export function wasTargetTime(
  task: { due_at: string | null; target_day_first_at?: string | null },
  timezone: string,
  dayStart: string,
): string | null {
  const first = task.target_day_first_at ?? null
  if (task.due_at === null || first === null) return null
  if (dayOf(first, timezone, dayStart) !== dayOf(task.due_at, timezone, dayStart)) return null
  const was = formatTimeInTimezone(first, timezone)
  return was === formatTimeInTimezone(task.due_at, timezone) ? null : was
}
