import { useMemo } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import {
  DueDateFilterBar,
  classifyTaskDueDate,
  type DueDateFilter,
} from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import type { Task } from '@/types'

/**
 * Combined filter bar for due date, priority, and label filters.
 * Date badges appear first, then priority, then labels,
 * separated by gray dividers. Horizontal scroll on narrow screens.
 *
 * AI chip: short press toggles AI filter, long press refreshes AI insights.
 * Annotation visibility is controlled via the hamburger menu, not here.
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
  aiInsightsCount,
  aiFilterActive = false,
  aiFilterLoading = false,
  onToggleAiFilter,
  onRefreshAi,
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
  aiInsightsCount?: number
  aiFilterActive?: boolean
  aiFilterLoading?: boolean
  onToggleAiFilter?: () => void
  onRefreshAi?: () => void
}) {
  const hasLabels = tasks.some((t) => t.labels.length > 0)

  // Check if the date filter section will actually render badges (needs 2+ buckets).
  // Mirrors DueDateFilterBar's internal check so the divider isn't orphaned.
  const dateFilterVisible = useMemo(() => {
    if (!timezone || !onToggleDateFilter || tasks.length === 0) return false
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(timezone)
    const allBuckets = new Set<string>()
    for (const task of tasks) {
      for (const bucket of classifyTaskDueDate(task, now, boundaries)) {
        allBuckets.add(bucket)
      }
      if (allBuckets.size > 1) return true
    }
    return false
  }, [timezone, onToggleDateFilter, tasks])

  if (tasks.length === 0) return null

  const hasSelection =
    selectedPriorities.length > 0 ||
    selectedLabels.length > 0 ||
    selectedDateFilters.length > 0 ||
    aiFilterActive

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        {onToggleAiFilter && aiInsightsCount != null && aiInsightsCount > 0 && (
          <>
            <AiChip
              active={aiFilterActive}
              loading={aiFilterLoading}
              count={aiInsightsCount}
              onToggleFilter={onToggleAiFilter}
              onRefresh={onRefreshAi}
            />
            <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />
          </>
        )}

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

/**
 * AI chip with short-press (toggle filter) and long-press (refresh).
 * Extracted to isolate the useSimpleLongPress hook call from the conditional
 * rendering block (hooks cannot be called conditionally).
 */
function AiChip({
  active,
  loading,
  count,
  onToggleFilter,
  onRefresh,
}: {
  active: boolean
  loading: boolean
  count: number
  onToggleFilter: () => void
  onRefresh?: () => void
}) {
  const press = useSimpleLongPress({
    onShortPress: onToggleFilter,
    onLongPress: () => {
      if (!loading) onRefresh?.()
    },
  })

  return (
    <button
      onClick={press.onClick}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerLeave={press.onPointerLeave}
      className={cn(
        'flex flex-shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-blue-600 text-white'
          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700',
      )}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
      AI
      <span className="opacity-60">{count}</span>
    </button>
  )
}
