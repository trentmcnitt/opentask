/**
 * The small, pure facts the sections are built from — each one the app's
 * existing rule where one exists (`isOverdue`, `deckIsToday`, `inSafetyNet`,
 * `showsHorizonDot`, the OpenTask day), so a section never re-derives a date
 * rule of its own.
 */
import { showsHorizonDot } from '@/lib/row-corner'
import { dayStartMoment, openTaskDayOf, openTaskDaysBetween } from '@/lib/opentask-day'
import { isOverdue } from '@/lib/task-counts'
import { deckIsToday, inSafetyNet, isPastDeadline } from '@/lib/task-segments'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'
import type { ModeContext } from './types'

/** A task the modes list at all: open, not a reminder, not a quota. */
export function isListable(task: Task): boolean {
  return !task.done && !task.deleted_at && !task.is_reminder && !isTracked(task)
}

/** The target has passed (the dashboard's Overdue). */
export function isOverTarget(task: Task, ctx: ModeContext): boolean {
  return isOverdue(task, ctx.now)
}

/** A target the user picked (not the deadline's automatic one). */
export function hasPickedTarget(task: Task): boolean {
  return task.due_at !== null && task.target_auto !== true
}

/** Whether an instant falls later on today's OpenTask day. */
function laterToday(iso: string, ctx: ModeContext): boolean {
  const at = new Date(iso)
  return (
    at > ctx.now &&
    openTaskDayOf(at, ctx.timezone, ctx.dayStart) ===
      openTaskDayOf(ctx.now, ctx.timezone, ctx.dayStart)
  )
}

/** Targeted for later today: its target falls on today's OpenTask day, still ahead. */
export function isTargetedLaterToday(task: Task, ctx: ModeContext): boolean {
  return task.due_at !== null && !isOverTarget(task, ctx) && laterToday(task.due_at, ctx)
}

/** On deck for today (or a leftover day the rollover has not stripped yet). */
export function isOnDeckToday(task: Task, ctx: ModeContext): boolean {
  return deckIsToday(task, ctx.timezone, ctx.now, ctx.dayStart)
}

/**
 * A deadline's safety net holds it today (from the day before the deadline's
 * OpenTask day) and nothing else makes it today's: no picked target.
 */
export function isInDeadlineNet(task: Task, ctx: ModeContext): boolean {
  return (
    task.deadline_at !== null &&
    !hasPickedTarget(task) &&
    inSafetyNet(task.deadline_at, ctx.timezone, ctx.now, ctx.dayStart)
  )
}

/**
 * TODAY's section: over target, targeted later today, or in a deadline's
 * safety net — one list, so a row never jumps sections when its time comes.
 */
export function isToday(task: Task, ctx: ModeContext): boolean {
  return isOverTarget(task, ctx) || isTargetedLaterToday(task, ctx) || isInDeadlineNet(task, ctx)
}

/** LATE (2026-10-29): the deadline has passed — only that; over target alone is not late. */
export function isLate(task: Task, ctx: ModeContext): boolean {
  return isPastDeadline(task.deadline_at, ctx.now)
}

/** "!!" first, then "!", then everything else alike (Medium, Low and None are one rank). */
export function markRank(task: Task): number {
  if (task.priority >= 4) return 0
  return task.priority === 3 ? 1 : 2
}

/**
 * Today's three runs, in order: due (the target has passed), later today
 * (a target still ahead today), the deadline's safety net.
 */
export function todayRun(task: Task, ctx: ModeContext): number {
  if (isOverTarget(task, ctx)) return 0
  return isTargetedLaterToday(task, ctx) ? 1 : 2
}

/** A Today row's time within its run: the target, but the deadline in the safety net. */
export function todayRunTime(task: Task, ctx: ModeContext): string | null {
  return todayRun(task, ctx) === 2 ? task.deadline_at : task.due_at
}

/** Today's order key: the target, else the deadline — past times sort first. */
export function todayTime(task: Task): string | null {
  return task.due_at ?? task.deadline_at
}

/** In the queue, pulled off a target or a deck by the rollover. */
export function wasPulled(task: Task): boolean {
  return (
    task.queued_at !== null &&
    (task.queued_from_due_at !== null || task.queued_from_deck_day !== null)
  )
}

/** Whole OpenTask days from `iso` to now (0 = today; negative = in the future). */
export function daysAgo(iso: string, ctx: ModeContext): number {
  return openTaskDaysBetween(new Date(iso), ctx.now, ctx.timezone, ctx.dayStart)
}

/**
 * What a task is "coming up" by: its deadline or its picked target,
 * whichever is sooner, while still ahead; null when it has neither.
 */
export function comingUpAt(task: Task, ctx: ModeContext): string | null {
  const deadline =
    task.deadline_at && !isPastDeadline(task.deadline_at, ctx.now) ? task.deadline_at : null
  const target = hasPickedTarget(task) && !isOverTarget(task, ctx) ? task.due_at : null
  if (deadline && (!target || deadline <= target)) return deadline
  return target
}

/**
 * A task its horizon governs — Scan's horizon sections: a plain one-off with
 * no picked target and no deadline (`showsHorizonDot`, the horizon segment's
 * rule). NOT the done square's rule (`horizonGoverns`): since 2026-10-29 the
 * square shows the set horizon on every one-off, targeted or not, but a
 * picked target or a deadline still sets a task's pace, so it stays out of
 * these sections.
 */
export function isHorizonGoverned(task: Task): boolean {
  return showsHorizonDot(task) && task.deadline_at === null
}

/**
 * Newest created first — ONE function, shared by Newest, the horizon
 * sections and the sort pill's "Newest", so a section can tell its rows run
 * by created date (Scan's age steps, `SectionView.ageSteps`).
 */
export const byNewestCreated = (a: Task, b: Task): number => newestFirst(a.created_at, b.created_at)

/** Newest first by an ISO field (nulls last). */
export function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? 1 : -1
}

/** Soonest first by an ISO field (nulls last). */
export function soonestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/** Higher priority first, then the newer task. */
export function byPriorityThenNewest(a: Task, b: Task): number {
  return b.priority - a.priority || newestFirst(a.created_at, b.created_at)
}

/** The instant an OpenTask date (YYYY-MM-DD) begins — to sort a date with instants. */
export function dateMoment(date: string, ctx: ModeContext): string {
  return dayStartMoment(date, ctx.timezone, ctx.dayStart).toISOString()
}
