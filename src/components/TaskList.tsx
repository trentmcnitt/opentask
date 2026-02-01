'use client'

// Selection integration via context
import { useCallback } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { TaskRow } from './TaskRow'
import { SwipeableRow } from './SwipeableRow'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Task, Project } from '@/types'
import { useGroupSort, type SortOption } from '@/hooks/useGroupSort'

export type GroupingMode = 'time' | 'project'

// Optional selection context - works whether or not SelectionProvider is present
interface SelectionContextType {
  selectedIds: Set<number>
  isSelectionMode: boolean
  toggle: (id: number) => void
  rangeSelect: (id: number, orderedIds: number[]) => void
}

// We import the context from SelectionProvider, but provide a safe fallback
const fallbackSelection: SelectionContextType = {
  selectedIds: new Set(),
  isSelectionMode: false,
  toggle: () => {},
  rangeSelect: () => {},
}

// Re-import the actual context
import { useSelection as useSelectionHook } from './SelectionProvider'

function useSafeSelection(): SelectionContextType {
  try {
    return useSelectionHook()
  } catch {
    return fallbackSelection
  }
}

interface TaskListProps {
  tasks: Task[]
  projects?: Project[]
  grouping?: GroupingMode
  onDone: (taskId: number) => void
  onSnooze: (task: Task) => void
  onSwipeSnooze?: (taskId: number, until: string) => void
}

// Sort tasks within a group
function sortTasks(tasks: Task[], sortOption: SortOption): Task[] {
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

export function TaskList({ tasks, projects = [], grouping = 'time', onDone, onSnooze, onSwipeSnooze }: TaskListProps) {
  const { getSortOption, setSortOption } = useGroupSort()
  const selection = useSafeSelection()

  // Snooze +1h helper for swipe (must be before early return for hooks rules)
  const handleSwipeSnooze = useCallback((task: Task) => {
    const snoozeTime = new Date(Date.now() + 60 * 60 * 1000)
    snoozeTime.setMinutes(0, 0, 0)
    if (onSwipeSnooze) {
      onSwipeSnooze(task.id, snoozeTime.toISOString())
    } else {
      onSnooze(task)
    }
  }, [onSwipeSnooze, onSnooze])

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="text-4xl mb-4">&#x2705;</div>
        <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-100">
          All caught up!
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          No tasks due right now.
        </p>
      </div>
    )
  }

  const groups = grouping === 'project'
    ? groupByProject(tasks, projects)
    : groupByTime(tasks)

  // Build ordered ID list for range-select
  const orderedIds = groups.flatMap((g) => g.tasks.map((t) => t.id))

  // Determine if we should show the "now" separator
  const hasOverdue = grouping === 'time' && groups.some((g) => g.label === 'Overdue')
  const hasUpcoming = grouping === 'time' && groups.some((g) => g.label !== 'Overdue')

  return (
    <div className="space-y-6">
      {groups.map((group, groupIdx) => {
        const sortOption = getSortOption(group.label)
        const sortedTasks = sortTasks(group.tasks, sortOption)

        return (
        <section key={group.label}>
          {/* "Now" separator between Overdue and the next group */}
          {hasOverdue && hasUpcoming && groupIdx === 1 && (
            <NowSeparator />
          )}

          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {group.label}
              <span className="ml-2 text-zinc-400 dark:text-zinc-500">
                {group.tasks.length}
              </span>
            </h2>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  <ArrowUpDown className="size-3 mr-1" />
                  {SORT_LABELS[sortOption]}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setSortOption(group.label, 'priority')}>
                  Priority
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortOption(group.label, 'title')}>
                  Title (A-Z)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortOption(group.label, 'age')}>
                  Age (oldest first)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="space-y-1">
            {sortedTasks.map((task) => (
              <SwipeableRow
                key={task.id}
                onSwipeRight={() => onDone(task.id)}
                onSwipeLeft={() => handleSwipeSnooze(task)}
              >
                <TaskRow
                  task={task}
                  onDone={() => onDone(task.id)}
                  onSnooze={() => onSnooze(task)}
                  isOverdue={isTaskOverdue(task)}
                  isSelected={selection.selectedIds.has(task.id)}
                  isSelectionMode={selection.isSelectionMode}
                  onSelect={() => selection.toggle(task.id)}
                  onRangeSelect={() => selection.rangeSelect(task.id, orderedIds)}
                />
              </SwipeableRow>
            ))}
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

interface TaskGroup {
  label: string
  tasks: Task[]
}

function groupByTime(tasks: Task[]): TaskGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
  const dayAfterTomorrow = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)
  const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

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
    projectTasks.sort((a, b) => {
      const now = Date.now()
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

function NowSeparator() {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return (
    <div className="flex items-center gap-3 py-3 mb-4" aria-label={`Current time: ${timeStr}`}>
      <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-700" />
      <span className="text-xs text-zinc-400 dark:text-zinc-500 font-medium whitespace-nowrap">
        now ({timeStr})
      </span>
      <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-700" />
    </div>
  )
}
