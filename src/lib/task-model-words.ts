/**
 * The task model's user-facing words (2026-10-10), each in ONE place because
 * Trent has not settled them: "Over target" ("not a fan of the name") and
 * "Horizon" ("doesn't resonate"). Change a word here and every web surface
 * follows. The native apps keep their own copy (see ios/AGENTS.md). API field
 * names (`due_at`/`target_at`, `horizon`) are not words and do not change.
 */
import type { CheckInDay, HorizonValue } from '@/lib/task-segments'

/** What "overdue" used to say: a task whose target has arrived. PROVISIONAL. */
export const OVER_TARGET = 'Over target'

/**
 * Said when a snooze can't quiet a task because its deadline is today (ruling
 * A4, 2026-10-11): on the deadline's own day only done, delete or the per-task
 * nag override silence it, so the snooze is saved but the nag stays on.
 */
export const DEADLINE_TODAY_HOLDS = 'Deadline today: this stays on until it’s done'
/** Lower-case, mid-sentence form ("3 over target"). */
export const OVER_TARGET_LOWER = 'over target'

/** The name of the pace field. PROVISIONAL. */
export const HORIZON_WORD = 'Horizon'

/** One word per horizon, for chips and segment headers. */
export const HORIZON_LABELS: Record<HorizonValue, string> = {
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  eventually: 'Eventually',
}

/**
 * When each segment comes round, after its name in the header ("TASKS · WEEKS
 * · Saturdays"), where a slot shows its start time. Short on purpose
 * (2026-10-12): the longer "Shown on the first Saturday" forms truncated on a
 * 390px phone beside the "X of Y" count and the pager's chevrons. Weeks and
 * Months name the user's check-in day (`users.check_in_day`, §3): "Tuesdays",
 * "1st Tuesday".
 */
export function horizonHints(checkInDay: CheckInDay): Record<HorizonValue, string> {
  const day = CHECK_IN_DAY_NAMES[checkInDay]
  return {
    days: 'Daily',
    weeks: `${day}s`,
    months: `1st ${day}`,
    eventually: 'Quarterly',
  }
}

/**
 * Upcoming (2026-10-12, spec §2): the heads-up segment's name and the word
 * after it in the header ("TASKS · UPCOMING · Heads-up") — its rows are
 * targeted tasks on their heads-up days, not a cadence.
 */
export const UPCOMING_LABEL = 'Upcoming'
export const UPCOMING_HINT = 'Heads-up'

/** The weekday names for the check-in day setting, 1 = Monday … 7 = Sunday. */
export const CHECK_IN_DAY_NAMES: Record<CheckInDay, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
}

/** An unset horizon is treated as weeks, but never shown as if it were set. */
export const HORIZON_UNSET_LABEL = 'Unset'

export const TARGET_WORD = 'Target'
export const DEADLINE_WORD = 'Deadline'

/**
 * The editor's greyed horizon row on a one-off with its own target (2026-10-12,
 * spec §1): "Target set: quiet until Nov 1".
 */
export function targetQuietUntil(date: string): string {
  return `Target set: quiet until ${date}`
}
