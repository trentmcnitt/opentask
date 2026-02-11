import { useMemo } from 'react'
import { Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
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
 * Two-row filter bar layout:
 *   Row 1: AI chip group (toggle + freshness + refresh) | date filter chips — horizontal scroll
 *   Row 2: Priority chips | label chips — wraps to multiple lines
 *
 * Row 1 is hidden when neither AI nor date filters are visible.
 * Clear-all X button anchors to the top-right, spanning the full container height.
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
  aiFreshnessText,
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
  aiFreshnessText?: string | null
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

  const aiChipVisible = onToggleAiFilter && aiInsightsCount != null && aiInsightsCount > 0
  const row1Visible = aiChipVisible || dateFilterVisible

  const hasSelection =
    selectedPriorities.length > 0 ||
    selectedLabels.length > 0 ||
    selectedDateFilters.length > 0 ||
    aiFilterActive

  return (
    <div className="relative mb-4">
      <div className="flex flex-col gap-2">
        {/* Row 1: AI chip group + date filters — horizontal scroll */}
        {row1Visible && (
          <div className="relative">
            <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pr-8">
              {aiChipVisible && (
                <AiChip
                  active={aiFilterActive}
                  loading={aiFilterLoading}
                  count={aiInsightsCount!}
                  freshnessText={aiFreshnessText}
                  onToggleFilter={onToggleAiFilter!}
                  onRefresh={onRefreshAi}
                />
              )}

              {aiChipVisible && dateFilterVisible && (
                <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />
              )}

              {dateFilterVisible && (
                <DueDateFilterBar
                  tasks={tasks}
                  selectedDateFilters={selectedDateFilters}
                  onToggleDateFilter={onToggleDateFilter!}
                  timezone={timezone!}
                />
              )}
            </div>

            {/* Clear-all X anchored to scroll row */}
            {hasSelection && (
              <div className="from-background pointer-events-none absolute top-0 right-0 flex h-full items-center bg-gradient-to-l from-50% to-transparent pl-4">
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
        )}

        {/* Row 2: Priority + label filters — wraps to fit */}
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityFilterBar
            tasks={tasks}
            selectedPriorities={selectedPriorities}
            onTogglePriority={onTogglePriority}
          />

          {hasLabels && (
            <LabelFilterBar
              tasks={tasks}
              selectedLabels={selectedLabels}
              onToggleLabel={onToggleLabel}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Enhanced AI chip group: filter toggle + freshness text + refresh button.
 * Replaces the previous long-press pattern with a visible refresh button.
 */
function AiChip({
  active,
  loading,
  count,
  freshnessText,
  onToggleFilter,
  onRefresh,
}: {
  active: boolean
  loading: boolean
  count: number
  freshnessText?: string | null
  onToggleFilter: () => void
  onRefresh?: () => void
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      {/* Filter toggle */}
      <button
        onClick={onToggleFilter}
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

      {/* Freshness text */}
      {freshnessText && (
        <span className="text-muted-foreground flex-shrink-0 text-[10px]">{freshnessText}</span>
      )}

      {/* Refresh button */}
      {onRefresh && (
        <button
          onClick={() => {
            if (!loading) onRefresh()
          }}
          disabled={loading}
          className="text-muted-foreground hover:text-foreground flex-shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-40"
          aria-label="Refresh AI insights"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      )}
    </div>
  )
}
