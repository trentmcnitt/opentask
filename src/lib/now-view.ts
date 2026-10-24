/**
 * NOW — the dashboard's front door (`default_grouping = 'project'`, 2026-10-14,
 * mockup E1; Trent: "drop the separate Today view").
 *
 * Now is every open task grouped by project, the way All was, but each project
 * shows only the rows that matter NOW and folds the rest. A task is relevant
 * now (`isRelevantNow`) when it is:
 *
 * 1. over target — `isOverdue`, the top bar's red-pill definition;
 * 2. targeted today — its target falls on the user's OpenTask today, later
 *    today included (`targetIsToday`, the task segments' own test; "Day
 *    starts at" PR 2, 2026-10-24: with a 3:00 AM day start, at 01:30 "today"
 *    is still the day before, and a 2:00 AM target is part of it). (With the
 *    task queue off, a deadline's AUTOMATIC target counts once its day comes:
 *    that is when the task starts to nag.)
 * 3. in today's Upcoming heads-up — exactly the Upcoming task segment's rule
 *    (`upcomingState` in `src/lib/task-segments.ts`), a picked target on one
 *    of its heads-up days (or carried over from one). Considered today still
 *    counts, as the segment still lists it, ticked; Defer All today ('deferred')
 *    does not — deferring says "not today";
 * 4. undated High or Urgent — priority 3 or 4 with no target at all. Not
 *    while it is in the task queue (A8, 2026-10-20).
 *
 * THE DEADLINES PAGE (2026-10-22, queue on): a deadline task with no target
 * is held by the deadlines page — relevant here ONLY in its safety net (from
 * the day before its deadline's OpenTask day, past the deadline included),
 * whatever its priority, like A8 for the queue.
 *
 * ON DECK (2026-10-20): a task on deck for today (or an earlier day not yet
 * stripped) is NOT relevant here — it belongs to the On deck section — unless
 * a deadline's automatic target has arrived; a future deck is relevant on its
 * Upcoming heads-up days only. The server's list of today's decks is
 * `onDeckToday` (src/core/tasks/deck.ts).
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
import {
  deckIsToday,
  inSafetyNet,
  isDeadlinePageTask,
  targetIsToday,
  upcomingState,
} from '@/lib/task-segments'

/** High (3) and Urgent (4): the priorities an undated task needs to be relevant now. */
export const NOW_PRIORITY_MIN = 3

/**
 * `opts.queue`: the task queue's server switch (the browser's `useTaskQueue`,
 * like `attemptsOffer`). Only with it on does the undated-High rule skip a
 * queued task (A8); off, main's behaviour exactly — a rollback leaves no
 * High task hidden behind a fold.
 */
export interface NowOptions {
  queue?: boolean
  /**
   * The user's day boundary (`useDayStart`: the day start with the task
   * queue on, midnight off): "today", Upcoming's heads-up days, today's decks
   * and the deadlines page's safety net are all OpenTask days.
   */
  dayStart: string
}

export function isRelevantNow(task: Task, timezone: string, now: Date, opts: NowOptions): boolean {
  // Over target first. Belt and braces: A1 (strict) keeps a deck off a task
  // whose automatic target has arrived, but one that nags is relevant, deck
  // or not.
  if (task.due_at !== null && isOverdue(task, now)) return true
  // The deadlines page (queue on): a target-less deadline task, deck or not,
  // is relevant only in its safety net.
  if (opts.queue && isDeadlinePageTask(task)) {
    return inSafetyNet(task.deadline_at!, timezone, now, opts.dayStart)
  }
  // ON DECK (2026-10-20, A13). Today's decks (and yesterday's leftovers until
  // the rollover strips them, A2) are not relevant in their project group:
  // they live in the On deck section (D2), and fold behind "+ N more" here so
  // "Show all" stays complete. A future deck is a plan, like a future picked
  // target: relevant only on its Upcoming heads-up days. With the queue
  // switch on only, like A8 — off, main's behaviour exactly.
  if (opts.queue && task.on_deck_day) {
    const heads = upcomingState(task, timezone, now, opts.dayStart)
    return heads !== null && heads.state !== 'deferred'
  }
  // Undated High/Urgent — but, with the queue on, not a QUEUED one (A8): the
  // queue already holds it, so it is not on two surfaces at once.
  if (task.due_at === null) {
    if (opts.queue && task.queued_at) return false
    return (task.priority ?? 0) >= NOW_PRIORITY_MIN
  }
  if (targetIsToday(task.due_at, timezone, now, opts.dayStart)) return true
  const heads = upcomingState(task, timezone, now, opts.dayStart)
  return heads !== null && heads.state !== 'deferred'
}

/** A project group's rows split by the Now rule, each part in the group's sort order. */
export interface NowSplit {
  /** Shown in place. */
  relevant: Task[]
  /** Behind the "+ N more in <Project>" fold. */
  more: Task[]
}

export function splitNow(
  sortedTasks: Task[],
  timezone: string,
  now: Date,
  opts: NowOptions,
): NowSplit {
  const relevant: Task[] = []
  const more: Task[] = []
  for (const task of sortedTasks) {
    if (isRelevantNow(task, timezone, now, opts)) relevant.push(task)
    else more.push(task)
  }
  return { relevant, more }
}

/**
 * NOW'S ON DECK SECTION (D2, 2026-10-20; spec rule 9, red-team A13): the
 * tasks it holds — on deck for today, or an earlier day the rollover has not
 * stripped yet (A2) — except one already over target (a deadline's automatic
 * target arrived, A1), which nags and so stays in its project's relevant
 * rows, as the server's `onDeckToday` leaves it out. At the top of Now (D2
 * review), sorted priority then id (`deckSectionOrder`). Only while Now's folds are on
 * (with Show all, a search or a filter, decks are ordinary rows in their
 * project), and only with the task queue on. Pass the same `opts` as
 * `isRelevantNow` (the queue switch, the day start).
 */
export function inDeckSection(task: Task, timezone: string, now: Date, opts: NowOptions): boolean {
  if (!deckIsToday(task, timezone, now, opts.dayStart) || isOverdue(task, now)) return false
  // THE DEADLINES PAGE (2026-10-22, plan §4): in its safety net a target-less
  // deadline task is the page's — on deck or not — and relevant in its
  // project (`isRelevantNow`), never in the On deck section too. The server's
  // `onDeckToday` leaves it out the same way.
  if (opts.queue && isDeadlinePageTask(task)) {
    return !inSafetyNet(task.deadline_at!, timezone, now, opts.dayStart)
  }
  return true
}

/** The On deck section's order: priority, highest first, then id (A13). */
export function deckSectionOrder(a: Task, b: Task): number {
  return (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id
}
