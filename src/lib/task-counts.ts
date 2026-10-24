/**
 * The three numbers the Tasks page keeps in its top bar — total, overdue,
 * due today — as one pure function, so the nav badges (Sidebar, BottomTabs)
 * and the counts endpoint the nav reads on other pages agree with the page
 * to the digit. One `now` for both filters keeps overdue and today consistent.
 */
import type { Task } from '@/types'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { isTracked } from '@/lib/track'

export interface TaskCounts {
  total: number
  /** due_at in the past. */
  overdue: number
  /** due_at inside the user's OpenTask day ("Day starts at" PR 2: from the day start to the next). */
  today: number
}

type CountableTask = Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>

/**
 * The target a count reads: `due_at` — a deadline's automatic target is
 * stored there too since 2026-10-12 (§8), so a deadline task is over target
 * from it, as the notifier and the badge say. Null for a quota.
 */
function countableTarget(task: CountableTask): string | null {
  return isTracked(task) ? null : task.due_at
}

/**
 * Whether a task carries a due date that can make it late or "due today".
 *
 * A quota is never late: "four times this week" cannot be overdue on a
 * Tuesday. Since 2026-09-08 a quota carries no `due_at` at all, so the
 * `due_at` check normally settles it; the `isTracked` check stays as the
 * explicit statement of the rule, and catches a legacy row the migration has
 * not reached yet. The notifier already refuses to fire on tracked items
 * (overdue-checker.ts, currently-due.ts); this makes the badges agree, so the
 * app no longer shows a debt it would never chase (Trent, 2026-09-06: "I
 * don't even know if they have reminders. Do they have times when they're
 * reminded?" — no, and now nothing implies they do).
 */
export function hasDebtDueDate(task: CountableTask): task is CountableTask & { due_at: string } {
  return task.due_at != null && !isTracked(task)
}

/**
 * THE definition of "overdue" on the Tasks page: a real due date strictly in
 * the past. Shared by `countTasks` (header pills, nav badges, GET
 * /api/tasks/counts) and `classifyTaskDueDate` (the Overdue filter chips and
 * the filter itself), so the pill and the chip cannot drift into two
 * definitions again. Snoozing moves `due_at` itself (`original_due_at` only
 * remembers where it was), so a snoozed task is overdue only once its NEW
 * time passes — `original_due_at` is deliberately not consulted.
 */
export function isOverdue(task: CountableTask, now: Date): boolean {
  const target = countableTarget(task)
  return target !== null && new Date(target) < now
}

export function countTasks(
  tasks: CountableTask[],
  timezone: string,
  /** The user's day boundary (`dayBoundaryForUser` / `useDayStart`): the Today pill's day. */
  dayStart: string,
  now: Date = new Date(),
): TaskCounts {
  const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone, dayStart, now)
  let overdue = 0
  let today = 0
  for (const t of tasks) {
    const target = countableTarget(t)
    if (target === null) continue
    const due = new Date(target)
    if (due < now) overdue++
    if (due >= todayStart && due < tomorrowStart) today++
  }
  return { total: tasks.length, overdue, today }
}
