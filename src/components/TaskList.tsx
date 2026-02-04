'use client'

// Selection integration via context
import { useCallback, useRef, useState, useEffect } from 'react'
import { ArrowUpDown } from 'lucide-react'
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
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'

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
  onSnooze: (task: Task) => void
  onSwipeSnooze?: (taskId: number, until: string) => void
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
  /** Optional: set sort option for a group (lifted from useGroupSort) */
  setSortOption?: (groupLabel: string, option: SortOption) => void
  /** Desktop click: set keyboard focus (blue glow) without selecting */
  onActivate?: (taskId: number) => void
}

// Sort tasks within a group - exported for use by keyboard navigation
export function sortTasks(tasks: Task[], sortOption: SortOption): Task[] {
  const sorted = [...tasks]
  switch (sortOption) {
    case 'priority':
      // Higher priority first (4=urgent, 0=unset), then by due date
      sorted.sort((a, b) => {
        const priorityDiff = (b.priority || 0) - (a.priority || 0)
        if (priorityDiff !== 0) return priorityDiff
        const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity
        const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity
        return aDue - bDue
      })
      break
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title))
      break
    case 'age':
      // Oldest first (by created_at)
      sorted.sort((a, b) => {
        const aCreated = a.created_at ? new Date(a.created_at).getTime() : Infinity
        const bCreated = b.created_at ? new Date(b.created_at).getTime() : Infinity
        return aCreated - bCreated
      })
      break
  }
  return sorted
}

const SORT_LABELS: Record<SortOption, string> = {
  priority: 'Priority',
  title: 'A-Z',
  age: 'Oldest',
}

export function TaskList({
  tasks,
  projects = [],
  grouping = 'time',
  onDone,
  onSnooze,
  onSwipeSnooze,
  onLabelClick,
  onTaskFocus,
  keyboardFocusedId,
  isKeyboardActive = false,
  onKeyDown,
  onListFocus,
  onListBlur,
  getSortOption: getSortOptionProp,
  setSortOption: setSortOptionProp,
  onActivate,
}: TaskListProps) {
  // Use props if provided (lifted state), otherwise use internal hook
  const internalSort = useGroupSort()
  const getSortOption = getSortOptionProp ?? internalSort.getSortOption
  const setSortOption = setSortOptionProp ?? internalSort.setSortOption
  const selection = useSelectionOptional() ?? fallbackSelection
  const timezone = useTimezone()
  const listRef = useRef<HTMLDivElement>(null)

  // Focus the listbox when entering selection mode (e.g., when clicking a task)
  // This ensures arrow keys work immediately after clicking a task
  useEffect(() => {
    if (selection.isSelectionMode && listRef.current) {
      listRef.current.focus()
    }
  }, [selection.isSelectionMode])

  // Snooze +1h helper for swipe (must be before early return for hooks rules)
  const handleSwipeSnooze = useCallback(
    (task: Task) => {
      const snoozeTime = new Date(Date.now() + 60 * 60 * 1000)
      snoozeTime.setMinutes(0, 0, 0)
      if (onSwipeSnooze) {
        onSwipeSnooze(task.id, snoozeTime.toISOString())
      } else {
        onSnooze(task)
      }
    },
    [onSwipeSnooze, onSnooze],
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

  // Build ordered ID list for range-select
  const orderedIds = groups.flatMap((g) => g.tasks.map((t) => t.id))

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
        const sortedTasks = sortTasks(group.tasks, sortOption)

        return (
          <section key={group.label}>
            {/* "Now" separator between Overdue and the next group */}
            {hasOverdue && hasUpcoming && groupIdx === 1 && <NowSeparator timezone={timezone} />}

            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                {selection.isSelectionMode && (
                  <GroupCheckbox
                    groupTaskIds={sortedTasks.map((t) => t.id)}
                    selection={selection}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
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
              <SortDropdown
                sortOption={sortOption}
                onSort={(option) => setSortOption(group.label, option)}
              />
            </div>
            <div className="space-y-1">
              {sortedTasks.map((task) => {
                const cancelRef = { current: null as (() => void) | null }
                return (
                  <SwipeableRow
                    key={task.id}
                    onSwipeRight={() => onDone(task.id)}
                    onSwipeLeft={() => handleSwipeSnooze(task)}
                    onDragStart={() => cancelRef.current?.()}
                    disabled={selection.isSelectionMode || isKeyboardActive}
                  >
                    <TaskRow
                      task={task}
                      onDone={() => onDone(task.id)}
                      onSnooze={() => onSnooze(task)}
                      isOverdue={isTaskOverdue(task)}
                      isSelected={selection.selectedIds.has(task.id)}
                      isSelectionMode={selection.isSelectionMode}
                      onSelect={() => selection.toggle(task.id)}
                      onSelectOnly={() => selection.selectOnly(task.id)}
                      onRangeSelect={() => selection.rangeSelect(task.id, orderedIds)}
                      cancelLongPressRef={cancelRef}
                      onLabelClick={onLabelClick}
                      onFocus={onTaskFocus ? () => onTaskFocus(task) : undefined}
                      isKeyboardFocused={isKeyboardActive && task.id === keyboardFocusedId}
                      onActivate={onActivate ? () => onActivate(task.id) : undefined}
                    />
                  </SwipeableRow>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function isTaskOverdue(task: Task): boolean {
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
  onSort,
}: {
  sortOption: SortOption
  onSort: (option: SortOption) => void
}) {
  const [open, setOpen] = useState(false)
  const isTouchRef = useRef(false)

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
          {SORT_LABELS[sortOption]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSort('priority')}>Priority</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSort('title')}>Title (A-Z)</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSort('age')}>Age (oldest first)</DropdownMenuItem>
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
