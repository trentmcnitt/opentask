/**
 * The three numbers the Tasks page keeps in its top bar — total, overdue,
 * due today — as one pure function, so the nav badges (Sidebar, BottomTabs)
 * and the counts endpoint the nav reads on other pages agree with the page
 * to the digit. One `now` for both filters keeps overdue and today consistent.
 */
import type { Task } from '@/types'
import { getTimezoneDayBoundaries } from '@/lib/format-date'

export interface TaskCounts {
  total: number
  /** due_at in the past. */
  overdue: number
  /** due_at inside the user's local day (DST-safe boundaries). */
  today: number
}

export function countTasks(
  tasks: Pick<Task, 'due_at'>[],
  timezone: string,
  now: Date = new Date(),
): TaskCounts {
  const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone, now)
  let overdue = 0
  let today = 0
  for (const t of tasks) {
    if (!t.due_at) continue
    const due = new Date(t.due_at)
    if (due < now) overdue++
    if (due >= todayStart && due < tomorrowStart) today++
  }
  return { total: tasks.length, overdue, today }
}
