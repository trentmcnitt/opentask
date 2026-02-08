'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import type { Task } from '@/types'

export type DueDateFilter = 'overdue' | 'soon' | 'today' | 'this_week' | 'later' | 'no_due_date'

interface DueDateFilterBarProps {
  tasks: Task[]
  selectedDateFilters: DueDateFilter[]
  onToggleDateFilter: (filter: DueDateFilter) => void
  timezone: string
}

const FILTER_LABELS: Record<DueDateFilter, string> = {
  overdue: 'Overdue',
  soon: 'Soon',
  today: 'Today',
  this_week: 'This Week',
  later: 'Later',
  no_due_date: 'No Due Date',
}

const FILTER_ORDER: DueDateFilter[] = [
  'overdue',
  'soon',
  'today',
  'this_week',
  'later',
  'no_due_date',
]

/**
 * Classify a task into a due date filter bucket.
 * "Soon" = due within the next 2 hours. "Today" = due today but not within 2 hours.
 */
export function classifyTaskDueDate(
  task: Task,
  now: Date,
  boundaries: ReturnType<typeof getTimezoneDayBoundaries>,
): DueDateFilter | null {
  if (!task.due_at) return 'no_due_date'

  const due = new Date(task.due_at)
  const soonBoundary = new Date(now.getTime() + 2 * 60 * 60 * 1000)

  if (due < now) return 'overdue'
  if (due < soonBoundary) return 'soon'
  if (due < boundaries.tomorrowStart) return 'today'
  if (due < boundaries.nextWeekStart) return 'this_week'
  return 'later'
}

/**
 * Renders due date filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses square badges (rounded-sm) to visually distinguish from pill-shaped label badges.
 */
export function DueDateFilterBar({
  tasks,
  selectedDateFilters,
  onToggleDateFilter,
  timezone,
}: DueDateFilterBarProps) {
  const filterCounts = useMemo(() => {
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(timezone)
    const counts = new Map<DueDateFilter, number>()

    for (const task of tasks) {
      const bucket = classifyTaskDueDate(task, now, boundaries)
      if (bucket) {
        counts.set(bucket, (counts.get(bucket) || 0) + 1)
      }
    }

    return FILTER_ORDER.filter((f) => counts.has(f)).map(
      (f) => [f, counts.get(f)!] as [DueDateFilter, number],
    )
  }, [tasks, timezone])

  if (filterCounts.length <= 1) return null

  return (
    <>
      {filterCounts.map(([filter, count]) => {
        const isSelected = selectedDateFilters.includes(filter)
        return (
          <Badge
            key={filter}
            variant="outline"
            className={cn(
              'flex-shrink-0 cursor-pointer rounded-sm transition-colors select-none',
              isSelected
                ? 'bg-foreground text-background border-foreground hover:bg-foreground/90'
                : 'hover:bg-muted',
            )}
            onClick={() => onToggleDateFilter(filter)}
          >
            <span className="leading-none">{FILTER_LABELS[filter]}</span>
            <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
          </Badge>
        )
      })}
    </>
  )
}
