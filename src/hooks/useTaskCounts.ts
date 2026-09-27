/**
 * Shared hook for computing task count badges (overdue, today).
 *
 * Thin memo over `countTasks` (src/lib/task-counts.ts), which is the single
 * definition the nav badges and GET /api/tasks/counts share.
 */

import { useMemo } from 'react'
import type { Task } from '@/types'
import { countTasks } from '@/lib/task-counts'
import { applyTaskFilters, type TaskFilterCriteria } from '@/hooks/useFilterState'

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

/**
 * The overdue / due-today numbers the Tasks top bar's red and today pills and
 * FilterBar's pinned Overdue chip show — all three from THIS one memo, so they
 * share one `now` and one population and cannot disagree with each other.
 *
 * The population is the date-filter FACET: `tasks` with every filter group
 * applied except the date group itself (`skipGroup: 'dateFilters'`) — exactly
 * the set the expanded Overdue/Today chips count (FilterBar's
 * `facetTasks.dateFilters`). So a pill reads "what you get if you tap me":
 * tapping applies the date filter exclusively (keeping the project/priority/
 * label filters), and the list then holds that many tasks.
 *
 * Why not the fully filtered list (what the header used to count): with a
 * Today filter on, the red pill showed "overdue AND due today", and with
 * What's Next on it showed only the overdue What's Next picks — a different
 * number from the Overdue chip for the same word (Trent, 2026-09-26: pill 8,
 * chip 9). The AI chips (What's Next, signals) are deliberately not applied,
 * matching the chip rows, which never apply them either.
 *
 * The expanded chips compute their own `now` when they mount, so after a task
 * crosses its due time with no data change in between, they can run one ahead
 * of this memo until the next refresh — the same staleness every overdue
 * indicator on the page has (none of them tick).
 */
export function useDateFacetCounts(
  tasks: Task[],
  criteria: TaskFilterCriteria,
  timezone: string,
): TaskCountsResult {
  return useMemo(() => {
    const facet = applyTaskFilters(tasks, criteria, { timezone, skipGroup: 'dateFilters' })
    const { overdue, today } = countTasks(facet, timezone)
    return { overdueCount: overdue, todayCount: today }
  }, [tasks, criteria, timezone])
}
