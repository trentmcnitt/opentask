/**
 * Shared hook for computing task count badges (overdue, today).
 *
 * Uses a single `now` reference to avoid inconsistencies between counts.
 * Uses getTimezoneDayBoundaries() for DST-safe "today" boundaries.
 */

import { useMemo } from 'react'
import type { Task } from '@/types'
import { getTimezoneDayBoundaries } from '@/lib/format-date'

interface TaskCounts {
  overdueCount: number
  todayCount: number
}

/**
 * Compute overdue and today counts from the full task list.
 *
 * @param allTasks Full task list (used for both overdueCount and todayCount)
 * @param timezone User's IANA timezone string
 */
export function useTaskCounts(allTasks: Task[], timezone: string): TaskCounts {
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

    return { overdueCount, todayCount }
  }, [allTasks, timezone])
}
