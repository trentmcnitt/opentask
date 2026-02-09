'use client'

// Selection integration via context
import { useCallback, useRef, useState, useEffect } from 'react'
import { ArrowUpDown, ChevronDown } from 'lucide-react'
import { TaskRow } from './TaskRow'
import { SwipeableRow } from './SwipeableRow'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Task, Project } from '@/types'
import { useGroupSort, type SortOption } from '@/hooks/useGroupSort'
import { useCollapsedGroups } from '@/hooks/useCollapsedGroups'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { computeSnoozeTime } from '@/lib/snooze'

export type GroupingMode = 'time' | 'project'

import { useSelectionOptional, type SelectionContextType } from './SelectionProvider'

const fallbackSelection: SelectionContextType = {
  selectedIds: new Set(),
  anchor: null,
  isSelectionMode: false,
  toggle: () => {},
  rangeSelect: () => {},
  selectAll: () => {},
  selectOnly: () => {},
  addAll: () => {},
  removeAll: () => {},
  clear: () => {},
}

interface TaskListProps {
  tasks: Task[]
  projects?: Project[]
  grouping?: GroupingMode
  onDone: (taskId: number) => void
  /** Called with (taskId, until) for immediate snooze (single-click, swipe, or menu) */
  onSnooze: (taskId: number, until: string) => void
  onLabelClick?: (label: string) => void
  onTaskFocus?: (task: Task) => void
  /** Currently keyboard-focused task ID */
  keyboardFocusedId?: number | null
  /** Whether keyboard navigation is active */
  isKeyboardActive?: boolean
  /** Keyboard event handler for list container */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Focus handler for list container */
  onListFocus?: (e: React.FocusEvent) => void
  /** Blur handler for list container */
  onListBlur?: (e: React.FocusEvent) => void
  /** Optional: get sort option for a group (lifted from useGroupSort) */
  getSortOption?: (groupLabel: string) => SortOption
  /** Optional: get reversed state for a group (lifted from useGroupSort) */
  getReversed?: (groupLabel: string) => boolean
  /** Optional: set sort option for a group (lifted from useGroupSort) */
  setSortOption?: (groupLabel: string, option: SortOption) => void
  /** Desktop click: set keyboard focus (blue glow) without selecting */
  onActivate?: (taskId: number) => void
  /** Desktop double-click: open QuickActionPanel */
  onDoubleClick?: (task: Task) => void
  /** Optional: check if a group is collapsed (lifted from useCollapsedGroups) */
  isCollapsed?: (groupLabel: string) => boolean
  /** Optional: toggle collapse for a group (lifted from useCollapsedGroups) */
  toggleCollapse?: (groupLabel: string) => void
}

// Sort tasks within a group - exported for use by keyboard navigation
export function sortTasks(tasks: Task[], sortOption: SortOption, reversed = false): Task[] {
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
  }
  return sorted
}

/** Labels shown on the compact sort button — direction-aware. */
const SORT_BUTTON_LABELS: Record<SortOption, { default: string; reversed: string }> = {
  due_date: { default: 'Soonest', reversed: 'Latest' },
  priority: { default: 'Priority ↓', reversed: 'Priority ↑' },
  title: { default: 'A-Z', reversed: 'Z-A' },
  age: { default: 'Newest', reversed: 'Oldest' },
  modified: { default: 'Modified ↓', reversed: 'Modified ↑' },
}

/** Labels shown in the dropdown menu items. */
const SORT_MENU_LABELS: Record<SortOption, string> = {
  due_date: 'Due date',
  priority: 'Priority',
  title: 'A-Z',
  age: 'Date added',
  modified: 'Date modified',
}

export function TaskList({
  tasks,
  projects = [],
  grouping = 'time',
  onDone,
  onSnooze,
  onLabelClick,
  onTaskFocus,
  keyboardFocusedId,
  isKeyboardActive = false,
  onKeyDown,
  onListFocus,
  onListBlur,
  getSortOption: getSortOptionProp,
  getReversed: getReversedProp,
  setSortOption: setSortOptionProp,
  onActivate,
  onDoubleClick,
  isCollapsed: isCollapsedProp,
  toggleCollapse: toggleCollapseProp,
}: TaskListProps) {
  // Use props if provided (lifted state), otherwise use internal hook
  const internalSort = useGroupSort()
  const getSortOption = getSortOptionProp ?? internalSort.getSortOption
  const getReversed = getReversedProp ?? internalSort.getReversed
  const setSortOption = setSortOptionProp ?? internalSort.setSortOption
  const internalCollapse = useCollapsedGroups()
  const isCollapsed = isCollapsedProp ?? internalCollapse.isCollapsed
  const toggleCollapse = toggleCollapseProp ?? internalCollapse.toggleCollapse
  const selection = useSelectionOptional() ?? fallbackSelection
  const timezone = useTimezone()
  const isMobile = useIsMobile()
  const listRef = useRef<HTMLDivElement>(null)

  // Focus the listbox when entering selection mode (e.g., when clicking a task)
  // This ensures arrow keys work immediately after clicking a task
  useEffect(() => {
    if (selection.isSelectionMode && listRef.current) {
      listRef.current.focus({ preventScroll: true })
    }
  }, [selection.isSelectionMode])

  // Swipe-left snooze uses the user's configured default snooze option
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()
  const handleSwipeSnooze = useCallback(
    (task: Task) => {
      const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
      onSnooze(task.id, until)
    },
    [defaultSnoozeOption, timezone, morningTime, onSnooze],
  )

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 text-4xl">&#x2705;</div>
        <h2 className="text-foreground text-xl font-medium">All caught up!</h2>
        <p className="text-muted-foreground mt-1">No tasks due right now.</p>
      </div>
    )
  }

  const groups =
    grouping === 'project' ? groupByProject(tasks, projects) : groupByTime(tasks, timezone)

  // Build ordered ID list for range-select, applying the same sort as rendering
  const orderedIds = groups.flatMap((g) => {
    const sortOption = getSortOption(g.label)
    const reversed = getReversed(g.label)
    return sortTasks(g.tasks, sortOption, reversed).map((t) => t.id)
  })

  // Determine if we should show the "now" separator
  const hasOverdue = grouping === 'time' && groups.some((g) => g.label === 'Overdue')
  const hasUpcoming = grouping === 'time' && groups.some((g) => g.label !== 'Overdue')

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Task list"
      aria-activedescendant={
        isKeyboardActive && keyboardFocusedId ? `task-row-${keyboardFocusedId}` : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onListFocus}
      onBlur={onListBlur}
      className="space-y-6 outline-none"
    >
      {groups.map((group, groupIdx) => {
        const sortOption = getSortOption(group.label)
        const reversed = getReversed(group.label)
        const sortedTasks = sortTasks(group.tasks, sortOption, reversed)
        const collapsed = isCollapsed(group.label)

        return (
          <section key={group.label}>
            {/* "Now" separator between Overdue and the next group */}
            {hasOverdue && hasUpcoming && groupIdx === 1 && <NowSeparator timezone={timezone} />}

            <div
              className={`flex min-h-7 items-center justify-between px-1 ${!collapsed ? 'mb-2' : ''}`}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleCollapse(group.label)}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                  className="text-muted-foreground hover:text-foreground -mr-1.5 flex items-center justify-center p-0.5 transition-colors"
                >
                  <ChevronDown
                    className={`size-3 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                  />
                </button>
                {!collapsed && selection.isSelectionMode && (
                  <GroupCheckbox
                    groupTaskIds={sortedTasks.map((t) => t.id)}
                    selection={selection}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    // When collapsed, clicking the label expands the group
                    if (collapsed) {
                      toggleCollapse(group.label)
                      return
                    }
                    const ids = sortedTasks.map((t) => t.id)
                    if (selection.isSelectionMode) {
                      // Toggle: if all selected, deselect all; otherwise select all
                      const allSelected = ids.every((id) => selection.selectedIds.has(id))
                      if (allSelected) {
                        selection.removeAll(ids)
                      } else {
                        selection.addAll(ids)
                      }
                    } else {
                      // Enter selection mode and select all in this group
                      selection.addAll(ids)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground text-xs font-semibold tracking-wider uppercase transition-colors"
                >
                  {group.label}
                  <span className="text-muted-foreground/60 ml-2">{group.tasks.length}</span>
                </button>
              </div>
              {!collapsed && (
                <SortDropdown
                  sortOption={sortOption}
                  reversed={reversed}
                  onSort={(option) => setSortOption(group.label, option)}
                />
              )}
            </div>
            {!collapsed && (
              <div className="space-y-1">
                {sortedTasks.map((task) => {
                  const cancelRef = { current: null as (() => void) | null }
                  return (
                    <SwipeableRow
                      key={task.id}
                      onSwipeRight={() => onDone(task.id)}
                      onSwipeLeft={() => handleSwipeSnooze(task)}
                      onDragStart={() => cancelRef.current?.()}
                      disabled={selection.isSelectionMode}
                    >
                      <TaskRow
                        task={task}
                        onDone={() => onDone(task.id)}
                        onSnooze={onSnooze}
                        isOverdue={isTaskOverdue(task)}
                        isSelected={selection.selectedIds.has(task.id)}
                        isSelectionMode={selection.isSelectionMode}
                        onSelect={() => selection.toggle(task.id)}
                        onSelectOnly={() => selection.selectOnly(task.id)}
                        onRangeSelect={() =>
                          selection.rangeSelect(task.id, orderedIds, keyboardFocusedId)
                        }
                        cancelLongPressRef={cancelRef}
                        onLabelClick={onLabelClick}
                        onFocus={onTaskFocus ? () => onTaskFocus(task) : undefined}
                        isKeyboardFocused={
                          isKeyboardActive && !isMobile && task.id === keyboardFocusedId
                        }
                        onActivate={onActivate ? () => onActivate(task.id) : undefined}
                        onDoubleClick={onDoubleClick ? () => onDoubleClick(task) : undefined}
                      />
                    </SwipeableRow>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

export function isTaskOverdue(task: Task): boolean {
  if (!task.due_at) return false
  return new Date(task.due_at) < new Date()
}

export interface TaskGroup {
  label: string
  tasks: Task[]
}

function groupByTime(tasks: Task[], timezone: string): TaskGroup[] {
  const now = new Date()
  const {
    tomorrowStart: tomorrow,
    dayAfterTomorrowStart: dayAfterTomorrow,
    nextWeekStart: nextWeek,
  } = getTimezoneDayBoundaries(timezone)

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

function groupByProject(tasks: Task[], projects: Project[]): TaskGroup[] {
  const projectMap = new Map<number, Project>()
  for (const p of projects) {
    projectMap.set(p.id, p)
  }

  // Group tasks by project
  const byProject = new Map<number, Task[]>()
  for (const task of tasks) {
    const list = byProject.get(task.project_id) || []
    list.push(task)
    byProject.set(task.project_id, list)
  }

  // Sort projects by sort_order
  const sortedProjectIds = [...byProject.keys()].sort((a, b) => {
    const pa = projectMap.get(a)
    const pb = projectMap.get(b)
    return (pa?.sort_order ?? 999) - (pb?.sort_order ?? 999)
  })

  const groups: TaskGroup[] = []

  for (const projectId of sortedProjectIds) {
    const project = projectMap.get(projectId)
    const projectTasks = byProject.get(projectId) || []

    // Sort within project: overdue first, then by due_at, then by anchor_time
    const now = Date.now()
    projectTasks.sort((a, b) => {
      const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity
      const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity
      const aOverdue = aDue < now ? 0 : 1
      const bOverdue = bDue < now ? 0 : 1

      if (aOverdue !== bOverdue) return aOverdue - bOverdue
      if (aDue !== bDue) return aDue - bDue
      // Fall back to anchor_time
      const aAnchor = a.anchor_time || '99:99'
      const bAnchor = b.anchor_time || '99:99'
      return aAnchor.localeCompare(bAnchor)
    })

    groups.push({
      label: project?.name || `Project ${projectId}`,
      tasks: projectTasks,
    })
  }

  return groups
}

function GroupCheckbox({
  groupTaskIds,
  selection,
}: {
  groupTaskIds: number[]
  selection: SelectionContextType
}) {
  const selectedCount = groupTaskIds.filter((id) => selection.selectedIds.has(id)).length
  const allSelected = selectedCount === groupTaskIds.length
  const someSelected = selectedCount > 0 && !allSelected

  return (
    <Checkbox
      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
      onCheckedChange={() => {
        if (allSelected) {
          selection.removeAll(groupTaskIds)
        } else {
          selection.addAll(groupTaskIds)
        }
      }}
      className="size-3.5"
      aria-label={allSelected ? 'Deselect all in group' : 'Select all in group'}
    />
  )
}

function SortDropdown({
  sortOption,
  reversed,
  onSort,
}: {
  sortOption: SortOption
  reversed: boolean
  onSort: (option: SortOption) => void
}) {
  const [open, setOpen] = useState(false)
  const isTouchRef = useRef(false)
  const label = reversed
    ? SORT_BUTTON_LABELS[sortOption].reversed
    : SORT_BUTTON_LABELS[sortOption].default

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-6 px-2 text-xs"
          onPointerDown={(e) => {
            isTouchRef.current = e.pointerType === 'touch'
            if (e.pointerType === 'touch') {
              e.preventDefault()
            }
          }}
          onClick={() => {
            if (isTouchRef.current) {
              setOpen((prev) => !prev)
              isTouchRef.current = false
            }
          }}
        >
          <ArrowUpDown className="mr-1 size-3" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(['due_date', 'priority', 'title', 'age', 'modified'] as const).map((option) => {
          const isActive = sortOption === option
          const itemLabel =
            isActive && reversed ? SORT_BUTTON_LABELS[option].reversed : SORT_MENU_LABELS[option]
          // Selecting the active option will toggle direction, so show what it will become
          const hint = isActive
            ? `→ ${reversed ? SORT_BUTTON_LABELS[option].default : SORT_BUTTON_LABELS[option].reversed}`
            : null
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => onSort(option)}
              className={isActive ? 'font-semibold' : ''}
            >
              {itemLabel}
              {hint && (
                <span className="text-muted-foreground ml-auto pl-3 text-[10px] font-normal">
                  {hint}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NowSeparator({ timezone }: { timezone: string }) {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return (
    <div className="mb-4 flex items-center gap-3 py-3" aria-label={`Current time: ${timeStr}`}>
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs font-medium whitespace-nowrap">
        now ({timeStr})
      </span>
      <div className="bg-border h-px flex-1" />
    </div>
  )
}

/**
 * Build task groups from tasks array. Exported for use by keyboard navigation
 * to compute orderedIds and find first task in group after completion.
 */
export function buildTaskGroups(
  tasks: Task[],
  projects: Project[],
  grouping: GroupingMode,
  timezone: string,
): TaskGroup[] {
  return grouping === 'project' ? groupByProject(tasks, projects) : groupByTime(tasks, timezone)
}
