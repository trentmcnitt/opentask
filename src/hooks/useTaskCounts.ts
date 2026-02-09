/**
 * Shared hook for computing task count badges (overdue, today, snoozable).
 *
 * Uses a single `now` reference to avoid inconsistencies between counts.
 * Uses getTimezoneDayBoundaries() for DST-safe "today" boundaries.
 */

import { useMemo } from 'react'
import type { Task } from '@/types'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'

interface TaskCounts {
  overdueCount: number
  todayCount: number
  snoozableOverdueCount: number
}

/**
 * Compute overdue, today, and snoozable-overdue counts from task lists.
 *
 * @param allTasks Full task list (used for overdueCount and todayCount)
 * @param filteredTasks Display-filtered list (used for snoozableOverdueCount)
 * @param timezone User's IANA timezone string
 */
export function useTaskCounts(
  allTasks: Task[],
  filteredTasks: Task[],
  timezone: string,
): TaskCounts {
  return useMemo(() => {
    const now = new Date()

    const overdueCount = allTasks.filter((t) => t.due_at && new Date(t.due_at) < now).length

    // DST-safe today boundaries
    const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone)
    const todayCount = allTasks.filter((t) => {
      if (!t.due_at) return false
      const due = new Date(t.due_at)
      return due >= todayStart && due < tomorrowStart
    }).length

    const snoozableOverdueCount = filteredTasks.filter(
      (t) => t.due_at && new Date(t.due_at) < now && (t.priority ?? 0) < HIGH_PRIORITY_THRESHOLD,
    ).length

    return { overdueCount, todayCount, snoozableOverdueCount }
  }, [allTasks, filteredTasks, timezone])
}
