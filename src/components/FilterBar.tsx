import { useMemo, useRef, useCallback } from 'react'
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
import { SIGNAL_ICONS } from '@/components/TaskRow'
import type { AiMode } from '@/hooks/useAiMode'
import type { Task } from '@/types'

/** Ring color for signal chip selection indicator */
function getSignalRingClass(key: string): string {
  const map: Record<string, string> = {
    review: 'ring-indigo-400',
    stale: 'ring-zinc-400',
    act_soon: 'ring-amber-400',
    quick_win: 'ring-green-400',
    vague: 'ring-blue-400',
    misprioritized: 'ring-purple-400',
  }
  return map[key] || 'ring-foreground'
}

/**
 * Filter bar layout adapts based on AI mode:
 *
 * Off mode:
 *   Row 1: date filter chips — horizontal scroll
 *   Row 2: Priority chips | label chips — wraps
 *
 * Bubble mode:
 *   Row 1: AI chip (toggle + count) | date filter chips — horizontal scroll
 *   Row 2: Priority chips | label chips — wraps
 *
 * Insight mode:
 *   Row 0: Signal chips (All, Review, Stale, ...) — horizontal scroll
 *   Row 1: date filter chips — horizontal scroll
 *   Row 2: Priority chips | label chips — wraps
 *
 * Clear-all X button anchors to the top-right, spanning the full container height.
 */
export function FilterBar({
  tasks,
  selectedPriorities,
  selectedLabels,
  selectedDateFilters = [],
  onTogglePriority,
  onExclusivePriority,
  onToggleLabel,
  onExclusiveLabel,
  onToggleDateFilter,
  onExclusiveDateFilter,
  onClearAll,
  timezone,
  aiMode = 'off',
  aiInsightsCount,
  aiFilterActive = false,
  aiFilterLoading = false,
  onToggleAiFilter,
  // Insight signal chips
  signalChips,
  selectedSignals = [],
  onSignalClick,
  onSignalLongPress,
  totalResultCount,
}: {
  tasks: Task[]
  selectedPriorities: number[]
  selectedLabels: string[]
  selectedDateFilters?: DueDateFilter[]
  onTogglePriority: (priority: number) => void
  onExclusivePriority?: (priority: number) => void
  onToggleLabel: (label: string) => void
  onExclusiveLabel?: (label: string) => void
  onToggleDateFilter?: (filter: DueDateFilter) => void
  onExclusiveDateFilter?: (filter: DueDateFilter) => void
  onClearAll: () => void
  timezone?: string
  aiMode?: AiMode
  aiInsightsCount?: number
  aiFilterActive?: boolean
  aiFilterLoading?: boolean
  onToggleAiFilter?: () => void
  // Insight mode signal chips
  signalChips?: { key: string; label: string; count: number; description: string }[]
  selectedSignals?: string[]
  onSignalClick?: (key: string, e: React.MouseEvent) => void
  onSignalLongPress?: (key: string) => void
  totalResultCount?: number
}) {
  const hasLabels = tasks.some((t) => t.labels.length > 0)

  // Check if the date filter section will actually render badges (needs 2+ buckets).
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

  const aiChipVisible =
    aiMode === 'bubble' && onToggleAiFilter && aiInsightsCount != null && aiInsightsCount > 0
  const signalRowVisible =
    aiMode === 'insight' && signalChips && signalChips.length > 0 && onSignalClick
  const row1Visible = aiChipVisible || dateFilterVisible

  const hasSelection =
    selectedPriorities.length > 0 ||
    selectedLabels.length > 0 ||
    selectedDateFilters.length > 0 ||
    aiFilterActive ||
    selectedSignals.length > 0

  return (
    <div className="relative mb-4">
      <div className="flex flex-col gap-2">
        {/* Row 0 (Insight mode only): Signal filter chips */}
        {signalRowVisible && (
          <div className="scrollbar-hide flex items-center gap-1.5 overflow-x-auto">
            <SignalChipRow
              chips={signalChips!}
              selectedSignals={selectedSignals}
              onClick={onSignalClick!}
              onLongPress={onSignalLongPress}
              totalCount={totalResultCount ?? 0}
            />
          </div>
        )}

        {/* Row 1: AI chip (bubble) + date filters — horizontal scroll */}
        {row1Visible && (
          <div className="relative">
            <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pr-8">
              {aiChipVisible && (
                <AiChip
                  active={aiFilterActive}
                  loading={aiFilterLoading}
                  count={aiInsightsCount!}
                  onToggleFilter={onToggleAiFilter!}
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
                  onExclusiveDateFilter={onExclusiveDateFilter}
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
            onExclusivePriority={onExclusivePriority}
          />

          {hasLabels && (
            <LabelFilterBar
              tasks={tasks}
              selectedLabels={selectedLabels}
              onToggleLabel={onToggleLabel}
              onExclusiveLabel={onExclusiveLabel}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Simplified AI chip for Bubble mode: filter toggle + count only.
 * Freshness text and refresh button have moved to AiControlArea.
 */
function AiChip({
  active,
  loading,
  count,
  onToggleFilter,
}: {
  active: boolean
  loading: boolean
  count: number
  onToggleFilter: () => void
}) {
  return (
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
  )
}

/**
 * Signal chip row for Insight mode. Colored chips with multi-select and
 * Cmd+click exclusive select. An "All (N)" chip clears the signal filter.
 */
function SignalChipRow({
  chips,
  selectedSignals,
  onClick,
  onLongPress,
  totalCount,
}: {
  chips: { key: string; label: string; count: number; description: string }[]
  selectedSignals: string[]
  onClick: (key: string, e: React.MouseEvent) => void
  onLongPress?: (key: string) => void
  totalCount: number
}) {
  return (
    <>
      {/* "All" chip — clears signal filter */}
      <button
        onClick={(e) => onClick('__clear_all__', e)}
        className={cn(
          'rounded-full px-3 py-1 text-xs font-medium transition-colors',
          selectedSignals.length === 0
            ? 'bg-foreground text-background'
            : 'bg-muted text-muted-foreground hover:bg-muted/80',
        )}
      >
        All ({totalCount})
      </button>
      {chips.map((chip) => {
        const isSelected = selectedSignals.includes(chip.key)
        const sig = SIGNAL_ICONS[chip.key]
        return (
          <SignalChipButton
            key={chip.key}
            chipKey={chip.key}
            label={chip.label}
            count={chip.count}
            description={chip.description}
            isSelected={isSelected}
            sig={sig}
            onClick={onClick}
            onLongPress={onLongPress}
          />
        )
      })}
    </>
  )
}

function SignalChipButton({
  chipKey,
  label,
  count,
  description,
  isSelected,
  sig,
  onClick,
  onLongPress,
}: {
  chipKey: string
  label: string
  count: number
  description: string
  isSelected: boolean
  sig?: { icon: React.ReactNode; label: string; bg: string; text: string }
  onClick: (key: string, e: React.MouseEvent) => void
  onLongPress?: (key: string) => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  return (
    <button
      onClick={(e) => {
        if (firedRef.current) {
          firedRef.current = false
          return
        }
        onClick(chipKey, e)
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch' || !onLongPress) return
        firedRef.current = false
        originRef.current = { x: e.clientX, y: e.clientY }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          firedRef.current = true
          onLongPress(chipKey)
        }, 400)
      }}
      onPointerUp={cancel}
      onPointerMove={(e) => {
        if (!timerRef.current || !originRef.current) return
        const dx = e.clientX - originRef.current.x
        const dy = e.clientY - originRef.current.y
        if (Math.sqrt(dx * dx + dy * dy) > 10) cancel()
      }}
      onPointerLeave={cancel}
      className={cn(
        'flex flex-shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors',
        isSelected
          ? cn(sig?.bg, sig?.text, 'ring-2', getSignalRingClass(chipKey))
          : cn(sig?.bg, sig?.text, 'opacity-60 hover:opacity-80'),
      )}
      title={description}
    >
      {sig?.icon}
      {label} ({count})
    </button>
  )
}
