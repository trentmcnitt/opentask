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
 * The grouping modes themselves are defined in `src/lib/grouping.ts`; Now's
 * "relevant now" rule and its folds in `src/lib/now-view.ts`.
 */
import { effectiveHorizon, HORIZON_ORDER } from '@/lib/task-segments'
import { isOverdue } from '@/lib/task-counts'
import type { LabelColor, Project, Task } from '@/types'
import type { GroupingMode } from '@/lib/grouping'
import {
  deckSectionOrder,
  inDeckSection,
  splitNow,
  type NowOptions,
  type NowSplit,
} from '@/lib/now-view'

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
  // 2026-10-10: over target first, then effective horizon (days → eventually),
  // deadline, priority, newest. See `horizonSortKey`.
  | 'horizon'

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
 * so Now and Unified still get the user's own sort. The list, keyboard order
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
    case 'horizon': {
      const now = new Date()
      sorted.sort((a, b) => {
        const cmp = compareHorizonOrder(a, b, now)
        return reversed ? -cmp : cmp
      })
      break
    }
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
  /** The project's id, on project groups — what Now's fold state is keyed by. */
  projectId?: number
  /** Now's On deck section (`withDeckSection`), not a project. */
  deck?: boolean
}

/** The On deck section's group label — its collapse key, never a project's name. */
export const DECK_GROUP_LABEL = '_on_deck'
/** Its heading. */
export const DECK_GROUP_TITLE = 'On deck'

/**
 * Now (`'project'`): one group per project that has open tasks, in the order
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
      projectId,
    }
  })
}

/**
 * Build task groups from tasks array. Used by the list itself and by keyboard
 * navigation to compute orderedIds and find first task in group after completion.
 *
 * - Newest and Unified (`isFlatGrouping`): one flat group.
 * - Now (`'project'`): one group per project (`groupByProject`), holding EVERY
 *   open task of the project — Now's folds are applied after sorting
 *   (`applyNowFolds`), so lookups by group (a notification's `?task=`, the
 *   Just now card's tap, the "N total" pill) still find a folded row.
 *
 * There is no Today (time-slot) grouping any more (dropped 2026-10-14, see
 * `src/lib/grouping.ts`) and no due-date grouping (gone 2026-09-30). The date
 * filter chips still narrow any view by due date.
 */
export function buildTaskGroups(
  tasks: Task[],
  projects: Project[],
  grouping: GroupingMode,
): TaskGroup[] {
  if (isFlatGrouping(grouping)) return [{ label: '_unified', tasks }]
  return groupByProject(tasks, projects)
}

/** A group with its rows in the order the list draws them. */
export interface SortedTaskGroup extends TaskGroup {
  sortedTasks: Task[]
  /**
   * Now's split of `sortedTasks` (`src/lib/now-view.ts`) — set only while the
   * folds are on (Now, nothing narrowing the list, Show all off). The list
   * draws `relevant`, then the fold row, then `more` when the fold is open.
   */
  now?: NowSplit
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
 * Now's folds (`src/lib/now-view.ts`): split every project group's sorted rows
 * into the relevant ones and the rest. The caller decides WHETHER the folds
 * are on (Now, nothing narrowing the list, Show all off).
 */
export function applyNowFolds(
  groups: SortedTaskGroup[],
  timezone: string,
  now: Date,
  opts: NowOptions,
): SortedTaskGroup[] {
  return groups.map((g) =>
    g.deck ? g : { ...g, now: splitNow(g.sortedTasks, timezone, now, opts) },
  )
}

/**
 * NOW'S ON DECK SECTION (D2; `inDeckSection` in src/lib/now-view.ts): today's
 * decks come OUT of their project groups — out of the rows and the fold
 * alike, so no task is drawn twice (one row id, one place in the keyboard
 * order) — into one group BEFORE the projects (the dashboard draws it at the
 * top of Now, D2 review 2026-10-20), sorted priority then id. A
 * project left with nothing is dropped, like any project with no open tasks.
 * No decks: the groups unchanged, and no section (no empty chrome). Applied
 * before `applyNowFolds`, only while Now's folds are on.
 */
export function withDeckSection(
  groups: SortedTaskGroup[],
  timezone: string,
  now: Date,
  opts: NowOptions,
): SortedTaskGroup[] {
  const decks: Task[] = []
  const projects: SortedTaskGroup[] = []
  for (const g of groups) {
    const keep = (t: Task) => !inDeckSection(t, timezone, now, opts)
    const rest = g.tasks.filter(keep)
    decks.push(...g.tasks.filter((t) => !keep(t)))
    if (rest.length === g.tasks.length) projects.push(g)
    else if (rest.length > 0)
      projects.push({ ...g, tasks: rest, sortedTasks: g.sortedTasks.filter(keep) })
  }
  if (decks.length === 0) return groups
  const sorted = [...decks].sort(deckSectionOrder)
  return [{ label: DECK_GROUP_LABEL, deck: true, tasks: sorted, sortedTasks: sorted }, ...projects]
}

/**
 * The rows a group draws, top to bottom: with Now's folds, the relevant rows
 * and — only while its fold is open — the rest after them; otherwise every row.
 */
export function shownGroupTasks(group: SortedTaskGroup, foldOpen: boolean): Task[] {
  if (!group.now) return group.sortedTasks
  return foldOpen ? [...group.now.relevant, ...group.now.more] : group.now.relevant
}

/** Now's fold key for a group: its project id (a rename keeps the fold), else its label. */
export function nowFoldKey(group: Pick<TaskGroup, 'label' | 'projectId'>): string {
  return group.projectId !== undefined ? String(group.projectId) : group.label
}

/**
 * The ids of the rows a user can reach, top to bottom: a collapsed group's
 * rows are off screen, and so are the rows behind a shut Now fold, so
 * keyboard navigation and shift-click ranges skip them. Rows past a group's
 * "Show all" preview cap are included.
 */
export function orderedTaskIds(
  sortedGroups: SortedTaskGroup[],
  isCollapsed: (label: string) => boolean,
  isFoldOpen: (key: string) => boolean = () => false,
): number[] {
  return sortedGroups.flatMap((g) =>
    isCollapsed(g.label) ? [] : shownGroupTasks(g, isFoldOpen(nowFoldKey(g))).map((t) => t.id),
  )
}

/**
 * The task model's dashboard order (2026-10-10, spec amendment 18): effective
 * horizon — with "now" (over target) ahead of days — then the nearest
 * deadline (none last), then priority, then the newest. Horizon and deadline
 * decide which tasks sit together; priority and recency only break ties.
 */
function horizonRank(task: Task, now: Date): number {
  if (isOverdue(task, now)) return -1
  return HORIZON_ORDER.indexOf(effectiveHorizon(task, now))
}

export function compareHorizonOrder(a: Task, b: Task, now: Date): number {
  const rank = horizonRank(a, now) - horizonRank(b, now)
  if (rank !== 0) return rank
  const aDl = a.deadline_at ? Date.parse(a.deadline_at) : Infinity
  const bDl = b.deadline_at ? Date.parse(b.deadline_at) : Infinity
  if (aDl !== bDl) return aDl < bDl ? -1 : 1
  const pri = (b.priority || 0) - (a.priority || 0)
  if (pri !== 0) return pri
  return Date.parse(b.created_at) - Date.parse(a.created_at)
}
