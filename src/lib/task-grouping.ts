/**
 * How the dashboard's task list is grouped and ordered — pure functions, no
 * React, so the list (`TaskList`), keyboard navigation (`useDashboardKeyboard`,
 * `DashboardClient`'s orderedIds) and the behavioral tests all share one copy.
 * The grouping modes themselves are defined in `src/lib/grouping.ts`; the Today
 * view's slot grouping lives in `src/lib/slot-view.ts`.
 */
import type { Task } from '@/types'
import type { GroupingMode } from '@/lib/grouping'
import { groupByTimeSlot } from '@/lib/slot-view'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The sort options for a task list. Default directions (reversed flips them;
 * selecting the active option again toggles the direction):
 *   - due_date: soonest first, no due date last (reversed = latest first)
 *   - priority: highest first (reversed = lowest first)
 *   - title: A-Z (reversed = Z-A)
 *   - age: newest first (reversed = oldest first)
 *   - modified: most recently modified first (reversed = least recently modified first)
 *   - original_due: earliest original due first, none last
 *   - ai_insights: highest AI score first, unscored last
 */
export type SortOption =
  | 'due_date'
  | 'priority'
  | 'title'
  | 'age'
  | 'modified'
  | 'original_due'
  | 'ai_insights'

/**
 * New and Unified are one flat list: no group headers, no preview cap, no
 * collapse, and every row names its project (there is no project heading to
 * say it). They differ only in order — see `effectiveSort`.
 */
export function isFlatGrouping(grouping: GroupingMode): boolean {
  return grouping === 'unified' || grouping === 'new'
}

/**
 * The sort a list is actually drawn in. New is newest-added first, always: the
 * `age` sort unreversed, whatever the saved sort preference says — that order
 * is what makes it New (Trent, 2026-09-29). The saved preference is left alone,
 * so All and Unified still get the user's own sort. The list, keyboard order
 * and every other reader of the visual order must go through this, or arrow
 * keys and the visual order disagree in New.
 */
export function effectiveSort(
  grouping: GroupingMode,
  sortOption: SortOption,
  reversed: boolean,
): { sortOption: SortOption; reversed: boolean } {
  return grouping === 'new' ? { sortOption: 'age', reversed: false } : { sortOption, reversed }
}

/**
 * Sort tasks within a group. The list, keyboard navigation and the clipboard
 * copy all order rows through this (after `effectiveSort`).
 */
export function sortTasks(
  tasks: Task[],
  sortOption: SortOption,
  reversed = false,
  insightsScoreMap?: Map<number, number>,
): Task[] {
  const sorted = [...tasks]
  switch (sortOption) {
    case 'due_date':
      // Default: soonest first, no due date last; priority as tiebreaker
      sorted.sort((a, b) => {
        const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity
        const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity
        const cmp = aDue - bDue
        if (cmp !== 0) return reversed ? -cmp : cmp
        return (b.priority || 0) - (a.priority || 0)
      })
      break
    case 'priority':
      // Default: highest first (4=urgent, 0=unset), then by due date
      sorted.sort((a, b) => {
        const priorityDiff = (b.priority || 0) - (a.priority || 0)
        if (priorityDiff !== 0) return reversed ? -priorityDiff : priorityDiff
        const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity
        const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity
        return aDue - bDue
      })
      break
    case 'title':
      sorted.sort((a, b) => {
        const cmp = a.title.localeCompare(b.title)
        return reversed ? -cmp : cmp
      })
      break
    case 'age':
      // Default: newest first (reversed = oldest first)
      sorted.sort((a, b) => {
        const aCreated = a.created_at ? new Date(a.created_at).getTime() : Infinity
        const bCreated = b.created_at ? new Date(b.created_at).getTime() : Infinity
        const cmp = bCreated - aCreated
        return reversed ? -cmp : cmp
      })
      break
    case 'modified':
      sorted.sort((a, b) => {
        const aUpdated = new Date(a.updated_at).getTime()
        const bUpdated = new Date(b.updated_at).getTime()
        const cmp = bUpdated - aUpdated
        return reversed ? -cmp : cmp
      })
      break
    case 'original_due':
      // Default: earliest original_due first (oldest origin at top). Null → end.
      sorted.sort((a, b) => {
        const aOrig = a.original_due_at ? new Date(a.original_due_at).getTime() : Infinity
        const bOrig = b.original_due_at ? new Date(b.original_due_at).getTime() : Infinity
        const cmp = aOrig - bOrig
        if (cmp !== 0) return reversed ? -cmp : cmp
        return (b.priority || 0) - (a.priority || 0)
      })
      break
    case 'ai_insights':
      // Default: highest score first (most attention needed). Tasks without scores → end.
      sorted.sort((a, b) => {
        const aScore = insightsScoreMap?.get(a.id) ?? -1
        const bScore = insightsScoreMap?.get(b.id) ?? -1
        const cmp = bScore - aScore
        return reversed ? -cmp : cmp
      })
      break
  }
  return sorted
}

export interface TaskGroup {
  label: string
  tasks: Task[]
}

function groupByTime(tasks: Task[], timezone: string, now: Date): TaskGroup[] {
  const {
    tomorrowStart: tomorrow,
    dayAfterTomorrowStart: dayAfterTomorrow,
    nextWeekStart: nextWeek,
  } = getTimezoneDayBoundaries(timezone, now)

  const buckets: Record<string, Task[]> = {
    Overdue: [],
    Today: [],
    Tomorrow: [],
    'This Week': [],
    Later: [],
    'No Due Date': [],
  }

  for (const task of tasks) {
    if (!task.due_at) {
      buckets['No Due Date'].push(task)
      continue
    }

    const due = new Date(task.due_at)

    if (due < now) {
      buckets['Overdue'].push(task)
    } else if (due < tomorrow) {
      buckets['Today'].push(task)
    } else if (due < dayAfterTomorrow) {
      buckets['Tomorrow'].push(task)
    } else if (due < nextWeek) {
      buckets['This Week'].push(task)
    } else {
      buckets['Later'].push(task)
    }
  }

  // Insert "now" separator within Today group if there are both overdue and upcoming
  const groups: TaskGroup[] = []
  const order = ['Overdue', 'Today', 'Tomorrow', 'This Week', 'Later', 'No Due Date']

  for (const label of order) {
    if (buckets[label].length > 0) {
      groups.push({ label, tasks: buckets[label] })
    }
  }

  return groups
}

/**
 * Build task groups from tasks array. Used by the list itself and by keyboard
 * navigation to compute orderedIds and find first task in group after completion.
 *
 * The `slot` branch (`groupByTimeSlot` in `src/lib/slot-view.ts`) groups today's
 * tasks into time slots (§7.3), and must not do two things:
 *
 * 1. Drop the un-slotted items. Anything with no time of day — which is most
 *    Track items — goes into an explicit "Undated" group rendered AFTER
 *    the timed slots. §7.3 is explicit that they must not become invisible
 *    from the front door.
 * 2. Hide empty slots... except when the whole day is empty. A slot the user
 *    defined is part of how they read their day, so an empty "Midday" still
 *    renders as a container. But rendering five empty containers when there is
 *    genuinely nothing left defeats the "all caught up" feeling §7.3 asks for,
 *    so a fully-empty day collapses to no groups and the caught-up state shows.
 */
export function buildTaskGroups(
  tasks: Task[],
  grouping: GroupingMode,
  timezone: string,
  timeSlots: TimeSlot[] = [],
  now: Date = new Date(),
): TaskGroup[] {
  if (isFlatGrouping(grouping)) return [{ label: '_unified', tasks }]
  if (grouping === 'slot') return groupByTimeSlot(tasks, timeSlots, timezone, now)
  return groupByTime(tasks, timezone, now)
}
