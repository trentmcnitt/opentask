/**
 * THE DEADLINE CHIP's words and tone (the deadlines page, 2026-10-22, plan
 * §9): one chip on every task row's second line — right after the project
 * (Trent's 10-20 rule: every project starts at the same x), first where the
 * line has no project (the dashboard row) — the horizon
 * and queue segments, Upcoming, the deadlines page, Now's On deck section and
 * the dashboard row — in place of the trailing "deadline …" text each used to
 * write its own way. Pure, so the rows and the tests share one copy
 * (`tests/behavioral/dl-deadline-chip.test.ts`); drawn by `DeadlineChip`.
 *
 * TONE, one meaning each (Trent, 2026-10-28, the time chips — `TimeChip`):
 *  - 'passed' (red): the deadline has passed — red means only that, app-wide;
 *  - 'today' (solid teal): the deadline is on today's OpenTask day;
 *  - 'ahead' (teal): any later day. The day before is no longer amber (the
 *    safety net's own colour until 2026-10-28): "Deadline tomorrow" says it.
 *
 * WORDS: "Deadline today" / "tomorrow" / "Fri" (within the week) / "Oct 30";
 * passed, "Past deadline Oct 20" ("… yesterday", "… today").
 *
 * L9 (plan §13): a deadline between midnight and the rollover counts on the
 * EVENING BEFORE — its OpenTask day (`repeatingDeadlineDay`). Fri 00:00 with a
 * 4 AM rollover is Thursday's, so its safety net starts Wednesday. The chip
 * says so — "Deadline Thu night" — so the day before it reads as the day
 * before, not as a calendar-day surprise. The tooltip keeps the exact moment.
 */
import { DateTime } from 'luxon'
import { isPastDeadline } from '@/lib/task-segments'
import { LAST_NIGHT, nightDay, nightWeekday } from '@/lib/night-day'

export type DeadlineTone = 'passed' | 'today' | 'ahead'

export interface DeadlineChipFacts {
  text: string
  tone: DeadlineTone
  /** The exact deadline, for the tooltip: "Fri Oct 30, 12:00 AM". */
  title: string
}

/** Days within which a deadline is named by its weekday. */
const WEEKDAY_WITHIN = 6

export function deadlineChip(
  deadlineAt: string,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): DeadlineChipFacts {
  const at = DateTime.fromISO(deadlineAt, { zone: 'utc' }).setZone(timezone)
  const title = `Deadline ${at.toFormat('ccc LLL d, h:mm a')}`
  // The OpenTask day the deadline counts on, its gap from today's, and
  // whether it is in that day's night (L9, `nightDay` — one rule app-wide).
  const n = nightDay(at.toJSDate(), timezone, rolloverTime, now)
  const { day, gap, night } = n
  if (isPastDeadline(deadlineAt, now)) {
    // Just passed, on its own (evening-before) day: "Thu night", never "tonight".
    const past = night && gap === 0 ? nightWeekday(n) : dayWords(day, gap, night)
    return { text: `Past deadline ${past}`, tone: 'passed', title }
  }
  const words = dayWords(day, gap, night)
  return { text: `Deadline ${words}`, tone: gap === 0 ? 'today' : 'ahead', title }
}

/** "today", "tomorrow", "yesterday", "Fri", "Oct 30" — "… night" on L9's evening-before day ("last night", not "yesterday night"). */
function dayWords(day: DateTime, gap: number, night: boolean): string {
  const suffix = night ? ' night' : ''
  if (gap === 0) return night ? 'tonight' : 'today'
  if (gap === 1) return `tomorrow${suffix}`
  if (gap === -1) return night ? LAST_NIGHT : 'yesterday'
  if (gap > 1 && gap <= WEEKDAY_WITHIN) return `${day.toFormat('ccc')}${suffix}`
  return `${day.toFormat('LLL d')}${suffix}`
}
