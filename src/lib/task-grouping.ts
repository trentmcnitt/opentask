/**
 * How the dashboard's task list is grouped and ordered — pure functions, no
 * React, so the list and the behavioral tests share one copy.
 *
 * The dashboard (`HomeContent` in `DashboardClient`) sorts ONCE: it builds the
 * groups, runs `sortTaskGroups` with the effective sort (`effectiveSort`) and
 * the AI score map, and hands the result to everything that reads the visual
 * order — `TaskList` renders it, `orderedTaskIds` feeds arrow keys, Home/End
 * and shift-click ranges, and `useDashboardKeyboard` copies from it. Sorting
 * separately in each of those once let them drift: under the AI sort the list
 * was drawn by score while the keyboard and clipboard ran in due-date order.
 * The grouping modes themselves are defined in `src/lib/grouping.ts`; the Today
 * view's slot grouping lives in `src/lib/slot-view.ts`.
 */
import type { LabelColor, Project, Task } from '@/types'
import type { GroupingMode } from '@/lib/grouping'
import { groupByTimeSlot } from '@/lib/slot-view'
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
  /** The project's color, on project groups — drawn as the heading's tag. */
  color?: LabelColor | null
}

/**
 * All (`'project'`): one group per project that has open tasks, in the order
 * Settings lists projects — `sort_order`, then name, the same rule as the
 * server's project list (`ORDER BY sort_order, name` in core/projects). It
 * used to break ties by insertion order, which followed the tasks' soonest-
 * first sort: projects sharing a `sort_order` swapped places whenever a
 * project's soonest task was completed (2026-09-23: completing an Inbox task
 * made the Inbox section jump away).
 *
 * Rows inside a group are not ordered here: `sortTaskGroups` sorts every
 * group by the user's sort, like every other view.
 */
function groupByProject(tasks: Task[], projects: Project[]): TaskGroup[] {
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const byProject = new Map<number, Task[]>()
  for (const task of tasks) {
    const list = byProject.get(task.project_id) ?? []
    list.push(task)
    byProject.set(task.project_id, list)
  }

  const sortedProjectIds = [...byProject.keys()].sort((a, b) => {
    const pa = projectMap.get(a)
    const pb = projectMap.get(b)
    return (
      (pa?.sort_order ?? 999) - (pb?.sort_order ?? 999) ||
      (pa?.name ?? '').localeCompare(pb?.name ?? '')
    )
  })

  return sortedProjectIds.map((projectId) => {
    const project = projectMap.get(projectId)
    return {
      label: project?.name || `Project ${projectId}`,
      tasks: byProject.get(projectId) ?? [],
      color: project?.color ?? null,
    }
  })
}

/**
 * Build task groups from tasks array. Used by the list itself and by keyboard
 * navigation to compute orderedIds and find first task in group after completion.
 *
 * - New and Unified (`isFlatGrouping`): one flat group.
 * - All (`'project'`): one group per project (`groupByProject`).
 * - Today (`'slot'`): today's tasks by time slot (`groupByTimeSlot` in
 *   `src/lib/slot-view.ts`).
 *
 * The `slot` branch groups today's tasks into time slots (§7.3), and must not
 * do two things:
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
 *
 * There is no due-date grouping any more. All used to be one (Overdue / Today
 * / Tomorrow / This Week / Later / No Due Date, stored as `'time'`) beside a
 * separate Projects view; since 2026-09-30 All IS the by-project grouping and
 * the due-date one is gone. The date filter chips still narrow any view by
 * due date.
 */
export function buildTaskGroups(
  tasks: Task[],
  projects: Project[],
  grouping: GroupingMode,
  timezone: string,
  timeSlots: TimeSlot[] = [],
  now: Date = new Date(),
): TaskGroup[] {
  if (isFlatGrouping(grouping)) return [{ label: '_unified', tasks }]
  if (grouping === 'slot') return groupByTimeSlot(tasks, timeSlots, timezone, now)
  return groupByProject(tasks, projects)
}

/** A group with its rows in the order the list draws them. */
export interface SortedTaskGroup extends TaskGroup {
  sortedTasks: Task[]
}

/**
 * Sort every group's rows — THE visual order of the dashboard list. Pass the
 * sort after `effectiveSort`, and the same AI score map the rows show, or the
 * `ai_insights` sort puts every row in the "unscored" tail.
 */
export function sortTaskGroups(
  groups: TaskGroup[],
  sortOption: SortOption,
  reversed: boolean,
  insightsScoreMap?: Map<number, number>,
): SortedTaskGroup[] {
  return groups.map((g) => ({
    ...g,
    sortedTasks: sortTasks(g.tasks, sortOption, reversed, insightsScoreMap),
  }))
}

/**
 * The ids of the rows a user can reach, top to bottom: a collapsed group's
 * rows are off screen, so keyboard navigation and shift-click ranges skip
 * them. Rows past a group's "Show all" preview cap are included.
 */
export function orderedTaskIds(
  sortedGroups: SortedTaskGroup[],
  isCollapsed: (label: string) => boolean,
): number[] {
  return sortedGroups.flatMap((g) => (isCollapsed(g.label) ? [] : g.sortedTasks.map((t) => t.id)))
}
