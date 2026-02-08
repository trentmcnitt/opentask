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
 * Classify a task into one or more due date filter buckets.
 * Tasks are classified along two independent axes:
 * - Time urgency (at most one): overdue, soon
 * - Calendar period (at most one): today, this_week, later
 * A task can appear in both a time-urgency and calendar-period bucket
 * (e.g., a task due today at 9 AM when it's now 3 PM is both "overdue" and "today").
 */
export function classifyTaskDueDate(
  task: Task,
  now: Date,
  boundaries: ReturnType<typeof getTimezoneDayBoundaries>,
): DueDateFilter[] {
  if (!task.due_at) return ['no_due_date']

  const due = new Date(task.due_at)
  const soonBoundary = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  const buckets: DueDateFilter[] = []

  // Time urgency (at most one)
  if (due < now) buckets.push('overdue')
  else if (due < soonBoundary) buckets.push('soon')

  // Calendar period (at most one)
  if (due >= boundaries.todayStart && due < boundaries.tomorrowStart) buckets.push('today')
  else if (due >= boundaries.tomorrowStart && due < boundaries.nextWeekStart)
    buckets.push('this_week')
  else if (due >= boundaries.nextWeekStart) buckets.push('later')

  return buckets
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
      const buckets = classifyTaskDueDate(task, now, boundaries)
      for (const bucket of buckets) {
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
