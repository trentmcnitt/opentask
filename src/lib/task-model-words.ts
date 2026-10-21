/**
 * The task model's user-facing words (2026-10-10), each in ONE place so a
 * ruling changes every web surface at once. "Overdue" is settled (Trent,
 * 2026-10-21: "over target" went back to "overdue"); "Horizon" is still
 * provisional ("doesn't resonate"). Change a word here and every web surface
 * follows. The native apps keep their own copy (see ios/AGENTS.md). API field
 * names (`due_at`/`target_at`, `horizon`) are not words and do not change.
 */
import type { CheckInDay, HorizonValue } from '@/lib/task-segments'

/** A task whose target has arrived (ruled 2026-10-21; "Over target" from 2026-10-10). */
export const OVERDUE_WORD = 'Overdue'

/** The editor's word for the deadline's stored automatic target (§8.1). */
export const AUTO_TARGET_WORD = 'auto'
/** The action that puts a picked target back to the automatic one (§8.3). */
export const BACK_TO_AUTO = 'Back to auto'
/** The picker's choice for the deadline's own day (ruling Q8). */
export const DEADLINE_DAY = 'Deadline day'
/** Lower-case, mid-sentence form ("3 overdue"). */
export const OVERDUE_LOWER = 'overdue'

/** The name of the pace field. PROVISIONAL. */
export const HORIZON_WORD = 'Horizon'

/** One word per horizon, for the horizon chips and picker. */
export const HORIZON_LABELS: Record<HorizonValue, string> = {
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  eventually: 'Eventually',
}

/**
 * The horizon segments' WORDS (Trent, 2026-10-20): one each. A panel header
 * is `TASK_QUEUE_PREFIX` · the word (`segmentTitle` in TaskSegmentRow); the
 * horizon-move toast says the bare word ("Moved to Weekly"). Display text
 * only: the segment kinds the API sends (`days` … `eventually`) do not change.
 */
export const SEGMENT_TITLES: Record<HorizonValue, string> = {
  days: 'Daily',
  weeks: 'Weekly',
  months: 'Monthly',
  eventually: 'Quarterly',
}

/**
 * When each horizon comes round, for the horizon picker and the row corner
 * (the panel headers carry only their title since 2026-10-20). Weeks and
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
 * Upcoming (2026-10-12, spec §2): the heads-up segment's word — its rows are
 * targeted tasks on their heads-up days, not a cadence. Its "Heads-up" hint
 * went with the others' (2026-10-20).
 */
export const UPCOMING_LABEL = 'Upcoming'

/**
 * THE TASK QUEUE (task queue PR 3, 2026-10-19; spec rule 6): the two panels'
 * words (Trent, 2026-10-21). "Today's pulls" holds the latest rollover's
 * strips, a manual Roll over now's included (`queue_today`); "Previous pulls"
 * the ones stripped before it (`queue_previous`). Not "Staged" (2026-10-20):
 * "Stage is what happens before something goes live, whereas this is for
 * things that were taken off and that potentially will stay off." Display
 * text only: the kind strings the API sends do not change.
 */
export const QUEUE_PANEL_TITLES = {
  queue_today: "Today's pulls",
  queue_previous: 'Previous pulls',
} as const

/**
 * Every task-segment panel's title is "Task queue · <word>" (Trent,
 * 2026-10-20: one format everywhere) — "TASK QUEUE · TODAY'S PULLS", "TASK QUEUE ·
 * DAILY", "TASK QUEUE · UPCOMING" on screen, where the header's `uppercase`
 * does the capitals. A middle dot, never an em dash.
 */
export const TASK_QUEUE_PREFIX = 'Task queue'
export function taskQueueTitle(word: string): string {
  return `${TASK_QUEUE_PREFIX} · ${word}`
}
/** Try Tomorrow's mark on a "Today's pulls" row (its tooltip and accessible name). */
export const TRY_TOMORROW_MARK = 'Try tomorrow'

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
