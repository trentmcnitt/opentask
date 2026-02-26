'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task } from '@/types'

export type DueDateFilter = 'overdue' | 'soon' | 'today' | 'this_week' | 'later' | 'no_due_date'

interface DueDateFilterBarProps {
  tasks: Task[]
  selectedDateFilters: DueDateFilter[]
  excludedDateFilters?: DueDateFilter[]
  onToggleDateFilter: (filter: DueDateFilter) => void
  timezone: string
  onExclusiveDateFilter?: (filter: DueDateFilter) => void
  onExcludeDateFilter?: (filter: DueDateFilter) => void
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
 *
 * Supports single-click toggle, double-click exclude, Cmd/Ctrl+click exclusive select,
 * and mobile long-press (400ms, 10px jitter) for exclusive select.
 */
export function DueDateFilterBar({
  tasks,
  selectedDateFilters,
  excludedDateFilters = [],
  onToggleDateFilter,
  timezone,
  onExclusiveDateFilter,
  onExcludeDateFilter,
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

    // Include any filter that has tasks OR is actively selected/excluded
    return FILTER_ORDER.filter(
      (f) => counts.has(f) || selectedDateFilters.includes(f) || excludedDateFilters.includes(f),
    ).map((f) => [f, counts.get(f) ?? 0] as [DueDateFilter, number])
  }, [tasks, timezone, selectedDateFilters, excludedDateFilters])

  const hasActiveFilter = selectedDateFilters.length > 0 || excludedDateFilters.length > 0
  if (filterCounts.length <= 1 && !hasActiveFilter) return null

  return (
    <>
      {filterCounts.map(([filter, count]) => {
        const chipState: ChipState = excludedDateFilters.includes(filter)
          ? 'excluded'
          : selectedDateFilters.includes(filter)
            ? 'included'
            : 'unselected'
        return (
          <DateChipBadge
            key={filter}
            filter={filter}
            label={FILTER_LABELS[filter]}
            count={count}
            chipState={chipState}
            onToggle={onToggleDateFilter}
            onExclusive={onExclusiveDateFilter}
            onExclude={onExcludeDateFilter}
          />
        )
      })}
    </>
  )
}

function DateChipBadge({
  filter,
  label,
  count,
  chipState,
  onToggle,
  onExclusive,
  onExclude,
}: {
  filter: DueDateFilter
  label: string
  count: number
  chipState: ChipState
  onToggle: (filter: DueDateFilter) => void
  onExclusive?: (filter: DueDateFilter) => void
  onExclude?: (filter: DueDateFilter) => void
}) {
  const handlers = useChipInteraction({
    chipKey: filter,
    chipState,
    onToggle,
    onExclusive,
    onExclude,
  })

  return (
    <Badge
      variant="outline"
      className={cn(
        'flex-shrink-0 cursor-pointer rounded-sm transition-colors select-none',
        chipState === 'excluded'
          ? EXCLUDED_CHIP_CLASSES
          : chipState === 'included'
            ? 'bg-foreground text-background border-foreground hover:bg-foreground/90'
            : 'hover:bg-muted',
      )}
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
    >
      <span className="leading-none">{label}</span>
      <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
