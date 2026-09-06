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

export function countTasks(
  tasks: Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>[],
  timezone: string,
  now: Date = new Date(),
): TaskCounts {
  const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone, now)
  let overdue = 0
  let today = 0
  for (const t of tasks) {
    if (!t.due_at) continue
    // A quota is never late. It carries a `due_at` — vestigial, from before it
    // was a quota, and still read by the iOS widget to draw its pace tick — but
    // that date is not a promise: "four times this week" cannot be overdue on a
    // Tuesday. The notifier already refuses to fire on tracked items
    // (overdue-checker.ts, currently-due.ts); this makes the badges agree, so
    // the app no longer shows a debt it would never chase (Trent, 2026-09-06:
    // "I don't even know if they have reminders. Do they have times when
    // they're reminded?" — no, and now nothing implies they do).
    if (isTracked(t)) continue
    const due = new Date(t.due_at)
    if (due < now) overdue++
    if (due >= todayStart && due < tomorrowStart) today++
  }
  return { total: tasks.length, overdue, today }
}
