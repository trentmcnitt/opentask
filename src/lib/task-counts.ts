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
  /** due_at inside the user's local day (DST-safe boundaries). */
  today: number
}

type CountableTask = Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>

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
  return hasDebtDueDate(task) && new Date(task.due_at) < now
}

export function countTasks(
  tasks: CountableTask[],
  timezone: string,
  now: Date = new Date(),
): TaskCounts {
  const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone, now)
  let overdue = 0
  let today = 0
  for (const t of tasks) {
    if (!hasDebtDueDate(t)) continue
    if (isOverdue(t, now)) overdue++
    const due = new Date(t.due_at)
    if (due >= todayStart && due < tomorrowStart) today++
  }
  return { total: tasks.length, overdue, today }
}
