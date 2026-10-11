/**
 * The task model's user-facing words (2026-10-10), each in ONE place because
 * Trent has not settled them: "Over target" ("not a fan of the name") and
 * "Horizon" ("doesn't resonate"). Change a word here and every web surface
 * follows. The native apps keep their own copy (see ios/AGENTS.md). API field
 * names (`due_at`/`target_at`, `horizon`) are not words and do not change.
 */
import type { HorizonValue } from '@/lib/task-segments'

/** What "overdue" used to say: a task whose target has arrived. PROVISIONAL. */
export const OVER_TARGET = 'Over target'
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

/** What each segment means, for its header's second line. */
export const HORIZON_HINTS: Record<HorizonValue, string> = {
  days: 'Shown every day',
  weeks: 'Shown on Saturdays',
  months: 'Shown on the first Saturday',
  eventually: 'Shown each quarter',
}

/** An unset horizon is treated as weeks, but never shown as if it were set. */
export const HORIZON_UNSET_LABEL = 'Unset'

export const TARGET_WORD = 'Target'
export const DEADLINE_WORD = 'Deadline'
