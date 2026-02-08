import { X } from 'lucide-react'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import {
  DueDateFilterBar,
  classifyTaskDueDate,
  type DueDateFilter,
} from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import type { Task } from '@/types'

/**
 * Combined filter bar for due date, priority, and label filters.
 * Date badges appear first, then priority, then labels, separated by gray dividers.
 * Horizontal scroll on narrow screens (no wrapping).
 */
export function FilterBar({
  tasks,
  selectedPriorities,
  selectedLabels,
  selectedDateFilters = [],
  onTogglePriority,
  onToggleLabel,
  onToggleDateFilter,
  onClearAll,
  timezone,
}: {
  tasks: Task[]
  selectedPriorities: number[]
  selectedLabels: string[]
  selectedDateFilters?: DueDateFilter[]
  onTogglePriority: (priority: number) => void
  onToggleLabel: (label: string) => void
  onToggleDateFilter?: (filter: DueDateFilter) => void
  onClearAll: () => void
  timezone?: string
}) {
  const hasLabels = tasks.some((t) => t.labels.length > 0)

  // Check if the date filter section will actually render badges (needs 2+ buckets).
  // Mirrors DueDateFilterBar's internal check so the divider isn't orphaned.
  const dateFilterVisible = (() => {
    if (!timezone || !onToggleDateFilter || tasks.length === 0) return false
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(timezone)
    const buckets = new Set<string>()
    for (const task of tasks) {
      const bucket = classifyTaskDueDate(task, now, boundaries)
      if (bucket) buckets.add(bucket)
      if (buckets.size > 1) return true
    }
    return false
  })()

  if (tasks.length === 0) return null

  const hasSelection =
    selectedPriorities.length > 0 || selectedLabels.length > 0 || selectedDateFilters.length > 0

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        {dateFilterVisible && (
          <DueDateFilterBar
            tasks={tasks}
            selectedDateFilters={selectedDateFilters}
            onToggleDateFilter={onToggleDateFilter!}
            timezone={timezone!}
          />
        )}

        {dateFilterVisible && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

        <PriorityFilterBar
          tasks={tasks}
          selectedPriorities={selectedPriorities}
          onTogglePriority={onTogglePriority}
        />

        {hasLabels && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

        {hasLabels && (
          <LabelFilterBar
            tasks={tasks}
            selectedLabels={selectedLabels}
            onToggleLabel={onToggleLabel}
          />
        )}
      </div>

      {hasSelection && (
        <div className="from-background pointer-events-none absolute right-0 flex items-center bg-gradient-to-l from-50% to-transparent pl-4">
          <button
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground pointer-events-auto flex-shrink-0 rounded-full p-1 transition-colors"
            aria-label="Clear all filters"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}
