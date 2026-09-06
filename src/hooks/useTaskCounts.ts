/**
 * Shared hook for computing task count badges (overdue, today).
 *
 * Thin memo over `countTasks` (src/lib/task-counts.ts), which is the single
 * definition the nav badges and GET /api/tasks/counts share.
 */

import { useMemo } from 'react'
import type { Task } from '@/types'
import { countTasks } from '@/lib/task-counts'

interface TaskCountsResult {
  overdueCount: number
  todayCount: number
}

/**
 * Compute overdue and today counts from the full task list.
 *
 * @param allTasks Full task list (used for both overdueCount and todayCount)
 * @param timezone User's IANA timezone string
 */
export function useTaskCounts(allTasks: Task[], timezone: string): TaskCountsResult {
  return useMemo(() => {
    const { overdue, today } = countTasks(allTasks, timezone)
    return { overdueCount: overdue, todayCount: today }
  }, [allTasks, timezone])
}
