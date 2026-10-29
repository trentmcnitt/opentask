/**
 * The task model's user-facing words (2026-10-10), each in ONE place so a
 * ruling changes every web surface at once. "Overdue" is settled (Trent,
 * 2026-10-21: "over target" went back to "overdue"); "Horizon" is still
 * provisional ("doesn't resonate"). Change a word here and every web surface
 * follows. The native apps keep their own copy (see ios/AGENTS.md). API field
 * names (`due_at`/`target_at`, `horizon`) are not words and do not change.
 */
import { UNSET_HORIZON } from '@/lib/task-segments'
import type { CheckInDay, HorizonValue, SegmentKind, UpcomingSection } from '@/lib/task-segments'

/** A task whose target has arrived (ruled 2026-10-21; "Over target" from 2026-10-10). */
export const OVERDUE_WORD = 'Overdue'

/**
 * A target's removal (2026-10-22: it replaced "Back to auto" — a deadline
 * task with no target goes on the deadlines page instead of getting an
 * automatic target).
 */
export const REMOVE_TARGET = 'Remove target'
/** The editor's target line with no target (2026-10-22). */
export const NO_TARGET = 'No target'
/** The pickers' choice for the deadline's own day (ruling Q8; "Deadline day" until 2026-10-24). */
export const DEADLINE_MORNING = 'Morning of the deadline'
/** The editor's lead row: when a deadline task with no target goes on the deadlines page. */
export const LEAD_WORD = 'Lead time'
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
 * is the word alone (`segmentTitle` in TaskSegmentRow; "Task queue ·" went
 * on 2026-10-29); the
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
 * The queue's two panels drawn as ONE segment on the web (2026-10-29,
 * `mergePulled`): its title and strip word. Its sections are Today and
 * Earlier (`PULLED_SECTION_WORDS`).
 */
export const PULLED_TITLE = 'Pulled'
export const PULLED_SECTION_WORDS = { today: 'Today', earlier: 'Earlier' } as const

/**
 * The task queue's STRIP (Trent's tight N2, 2026-10-29): a word over each
 * segment's bar, in four groups with their own small word above them. Where
 * the strip is narrow (a phone's card, the Reminders page's day bar) the long
 * words take their short form: "Deadlines" → "Due", "Heads up" → "Soon"
 * ("we'll do deadlines and heads up and then we'll change it to 'due' and
 * 'soon' for the phone"). The horizons wear their dot, no word.
 */
export const SEGMENT_STRIP_WORDS: Record<SegmentKind, { long: string; short: string } | null> = {
  deadlines: { long: 'Deadlines', short: 'Due' },
  upcoming: { long: 'Heads up', short: 'Soon' },
  // The two panels are one bar on the web, "Pulled" (`mergePulled`).
  queue_today: { long: PULLED_TITLE, short: PULLED_TITLE },
  queue_previous: { long: PULLED_TITLE, short: PULLED_TITLE },
  days: null,
  weeks: null,
  months: null,
  eventually: null,
  aged_out: { long: 'Aged', short: 'Aged' },
}

/** The strip's groups and their words; Aged out stands alone, wordless (`SEGMENT_ORDER`). */
export type StripGroup = 'dated' | 'pulled' | 'horizon' | 'aged'
export const SEGMENT_STRIP_GROUP: Record<SegmentKind, StripGroup> = {
  deadlines: 'dated',
  upcoming: 'dated',
  queue_today: 'pulled',
  queue_previous: 'pulled',
  days: 'horizon',
  weeks: 'horizon',
  months: 'horizon',
  eventually: 'horizon',
  aged_out: 'aged',
}
export const STRIP_GROUP_WORDS: Record<StripGroup, string> = {
  dated: 'Dated',
  pulled: 'Pulled',
  horizon: 'Horizon',
  aged: '',
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
export const UPCOMING_LABEL = 'Heads up'

/**
 * Upcoming's two sections (2026-10-25, the Upcoming split; plan
 * `plan-upcoming-split-1024.md`), in the order the page lists them: Tomorrow
 * (the day before a target or deck day) first, then Later (the lead-time
 * heads-up, carried over until seen). The API's `upcoming_section` values do
 * not change with these words.
 */
export const UPCOMING_SECTION_TITLES: Record<UpcomingSection, string> = {
  tomorrow: 'Tomorrow',
  later: 'Later',
}

/**
 * THE TASK QUEUE (task queue PR 3, 2026-10-19; spec rule 6): the two panels'
 * words (Trent, 2026-10-21). "Today's pulls" holds the latest rollover's
 * strips, a manual Roll over now's included (`queue_today`); "Previous pulls"
 * the ones stripped before it (`queue_previous`). Not "Staged" (2026-10-20):
 * "Stage is what happens before something goes live, whereas this is for
 * things that were taken off and that potentially will stay off." Display
 * text only: the kind strings the API sends do not change.
 */
/**
 * The dashboard's paged task-queue card: its header says "Task queue" on
 * every page, with no segment word after it (Trent, 2026-10-29: "I'd rather
 * you just said 'Task Queue' all the time") — the strip's words show which
 * page is on screen. The Reminders page, where every segment is its own
 * section, keeps each section's name (`segmentTitle`).
 */
export const TASK_QUEUE_TITLE = 'Task queue'

/** The deadlines page's title (2026-10-22). */
export const DEADLINES_PAGE_TITLE = 'Deadlines'

export const QUEUE_PANEL_TITLES = {
  queue_today: "Today's pulls",
  queue_previous: 'Previous pulls',
} as const

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

/**
 * An unset horizon in words (Trent, 2026-10-29): the horizon it reads as
 * first, "(unset)" after — "Weeks (unset)" — in the horizon menu, the dot's
 * tooltip and the editor's chip. From `UNSET_HORIZON`, never hardcoded.
 */
export const UNSET_HORIZON_WORDS = `${HORIZON_LABELS[UNSET_HORIZON]} (unset)`

export const TARGET_WORD = 'Target'
export const DEADLINE_WORD = 'Deadline'

/**
 * The editor's greyed horizon row on a one-off with its own target (2026-10-12,
 * spec §1): "Target set: quiet until Nov 1".
 */
export function targetQuietUntil(date: string): string {
  return `Target set: quiet until ${date}`
}
