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
 * @param now The page's clock (`useDashboardNow`) — a dependency, so the
 *   counts move when a task crosses its due time, not only when data changes
 */
export function useTaskCounts(allTasks: Task[], timezone: string, now: Date): TaskCountsResult {
  return useMemo(() => {
    const { overdue, today } = countTasks(allTasks, timezone, now)
    return { overdueCount: overdue, todayCount: today }
  }, [allTasks, timezone, now])
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
 * `now` is the page's one clock (`useDashboardNow`), shared with the expanded
 * chips, the filtered list and the task groups. It advances the instant a
 * task crosses its due time, so these counts tick with no data change —
 * until 2026-09-27 they did not, and a task going overdue while the page sat
 * open turned its row red but never lit the pill, the pinned chip or the
 * jump button (see `src/lib/dashboard-clock.ts`).
 */
export function useDateFacetCounts(
  tasks: Task[],
  criteria: TaskFilterCriteria,
  timezone: string,
  now: Date,
): TaskCountsResult {
  return useMemo(() => {
    const facet = applyTaskFilters(tasks, criteria, { timezone, now, skipGroup: 'dateFilters' })
    const { overdue, today } = countTasks(facet, timezone, now)
    return { overdueCount: overdue, todayCount: today }
  }, [tasks, criteria, timezone, now])
}
