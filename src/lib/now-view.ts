/**
 * NOW — the dashboard's front door (`default_grouping = 'project'`, 2026-10-14,
 * mockup E1; Trent: "drop the separate Today view").
 *
 * Now is every open task grouped by project, the way All was, but each project
 * shows only the rows that matter NOW and folds the rest. A task is relevant
 * now (`isRelevantNow`) when it is:
 *
 * 1. over target — `isOverdue`, the top bar's red-pill definition;
 * 2. targeted today — its target falls on the user's local today, later
 *    today included (`targetIsToday`, the task segments' own test). A
 *    deadline's AUTOMATIC target counts once its day comes: that is when the
 *    task starts to nag;
 * 3. in today's Upcoming heads-up — exactly the Upcoming task segment's rule
 *    (`upcomingState` in `src/lib/task-segments.ts`), a picked target on one
 *    of its heads-up days (or carried over from one). Considered today still
 *    counts, as the segment still lists it, ticked; Defer All today ('deferred')
 *    does not — deferring says "not today";
 * 4. undated High or Urgent — priority 3 or 4 with no target at all. (A
 *    deadline task always carries a target, its automatic one, so "undated"
 *    means no dates at all.)
 *
 * Everything else in the project — later targets, Low/Medium/unset with no
 * date — sits behind the project's fold row, "+ N more in <Project>", which
 * opens IN PLACE: the rest of the project's rows appear under the relevant
 * ones as ordinary task rows, then "Show fewer". A project with nothing
 * relevant is still listed, as its heading and the fold row alone ("· nothing
 * due"), so no project disappears from the front door. The fold state is per
 * project and lasts the browser session (`useNowFolds`).
 *
 * "N of M now · Show all M" beside the view switch: Show all lifts every fold
 * for the visit — the old All, with its `project_preview_count` cap — until
 * "Show N now" (or the Dashboard tab) puts Now back. Not saved. With nothing
 * folded (every row relevant, or no rows) the strip is not shown.
 *
 * WHILE ANYTHING NARROWS THE LIST (search, filter chips, the AI filter or
 * signal chips), the folds are off: the user asked for exactly those rows, and
 * a match hidden under "+ N more" would read as "no match". The relevant rows
 * themselves are never capped — the fold is the only thing that hides rows in
 * Now, so a project with twelve overdue tasks shows all twelve.
 *
 * The rows behind a fold are not reachable while it is shut: arrow keys,
 * Home/End and shift-click ranges skip them (`orderedTaskIds`), and a group's
 * select-all takes only the rows on screen. A notification or Just now tap on
 * a folded row opens its fold first.
 */
import type { Task } from '@/types'
import { isOverdue } from '@/lib/task-counts'
import { targetIsToday, upcomingState } from '@/lib/task-segments'

/** High (3) and Urgent (4): the priorities an undated task needs to be relevant now. */
export const NOW_PRIORITY_MIN = 3

export function isRelevantNow(task: Task, timezone: string, now: Date): boolean {
  if (task.due_at === null) return (task.priority ?? 0) >= NOW_PRIORITY_MIN
  if (isOverdue(task, now)) return true
  if (targetIsToday(task.due_at, timezone, now)) return true
  const heads = upcomingState(task, timezone, now)
  return heads !== null && heads.state !== 'deferred'
}

/** A project group's rows split by the Now rule, each part in the group's sort order. */
export interface NowSplit {
  /** Shown in place. */
  relevant: Task[]
  /** Behind the "+ N more in <Project>" fold. */
  more: Task[]
}

export function splitNow(sortedTasks: Task[], timezone: string, now: Date): NowSplit {
  const relevant: Task[] = []
  const more: Task[] = []
  for (const task of sortedTasks) {
    if (isRelevantNow(task, timezone, now)) relevant.push(task)
    else more.push(task)
  }
  return { relevant, more }
}
