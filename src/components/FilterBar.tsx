import { useMemo, useRef, useCallback } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import { AttributeFilterBar } from '@/components/AttributeFilterBar'
import { ProjectFilterBar } from '@/components/ProjectFilterBar'
import {
  DueDateFilterBar,
  classifyTaskDueDate,
  type DueDateFilter,
} from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { SIGNAL_ICONS } from '@/components/TaskRow'
import type { AiMode } from '@/hooks/useAiMode'
import type { Task, Project } from '@/types'

/** Solid fill classes for selected signal chips */
function getSignalSelectedClass(key: string): string {
  const map: Record<string, string> = {
    review: 'bg-indigo-600 text-white dark:bg-indigo-500',
    stale: 'bg-zinc-600 text-white dark:bg-zinc-500',
    act_soon: 'bg-amber-600 text-white dark:bg-amber-500',
    quick_win: 'bg-green-600 text-white dark:bg-green-500',
    vague: 'bg-blue-600 text-white dark:bg-blue-500',
    misprioritized: 'bg-purple-600 text-white dark:bg-purple-500',
  }
  return map[key] || 'bg-foreground text-background'
}

/**
 * Filter bar layout adapts based on AI mode:
 *
 * Off mode:
 *   Projects: [●Work 42] [●Personal 18] [●Side 6]             ← wrapping (if 2+ projects)
 *   Row 1: date filter chips — horizontal scroll
 *   Row 2: Priority chips | label chips — wraps
 *
 * On mode:
 *   AI Row:  [What's Next 6] [Stale 4] [Quick Win 1]           ← scrollable
 *            ─────────────────────────────────────────────      ← subtle border
 *   Projects: [●Work 42] [●Personal 18] [●Side 6]             ← wrapping (if 2+ projects)
 *   Row 1:  [Overdue 61] [Soon 3] [Today 6]                   ← scrollable
 *   Row 2:  [None 68] [Low 6] [Medium 6] [High 3] ...         ← wrapping
 *
 * Users clear filters by clicking active chips to deselect them.
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
  timezone,
  aiMode = 'off',
  aiInsightsCount,
  aiFilterActive = false,
  aiFilterLoading = false,
  onToggleAiFilter,
  // Insights chip (visibility toggle in FilterBar)
  insightsActive = false,
  onToggleInsights,
  hasInsightsData = false,
  insightsGenerating = false,
  insightsSignalChipsVisible = true,
  // Attribute filters (recurring, custom auto-snooze)
  attributeFilters,
  onToggleAttribute,
  onExclusiveAttribute,
  // Project filters
  projects,
  selectedProjects = [],
  onToggleProject,
  onExclusiveProject,
  todayCounts,
  // Exclude filters
  excludedPriorities = [],
  excludedLabels = [],
  excludedDateFilters = [],
  excludedAttributes,
  excludedProjects = [],
  onExcludePriority,
  onExcludeLabel,
  onExcludeDateFilter,
  onExcludeAttribute,
  onExcludeProject,
  // Signal chips
  signalChips,
  selectedSignals = [],
  onSignalClick,
  onSignalLongPress,
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
  timezone?: string
  aiMode?: AiMode
  aiInsightsCount?: number
  aiFilterActive?: boolean
  aiFilterLoading?: boolean
  onToggleAiFilter?: () => void
  // Insights chip (visibility toggle in FilterBar)
  insightsActive?: boolean
  onToggleInsights?: () => void
  hasInsightsData?: boolean
  insightsGenerating?: boolean
  insightsSignalChipsVisible?: boolean
  // Attribute filters (recurring, custom auto-snooze)
  attributeFilters?: Set<string>
  onToggleAttribute?: (key: string) => void
  onExclusiveAttribute?: (key: string) => void
  // Project filters
  projects?: Project[]
  selectedProjects?: number[]
  onToggleProject?: (projectId: number) => void
  onExclusiveProject?: (projectId: number) => void
  todayCounts?: Map<number, number>
  // Exclude filters
  excludedPriorities?: number[]
  excludedLabels?: string[]
  excludedDateFilters?: DueDateFilter[]
  excludedAttributes?: Set<string>
  excludedProjects?: number[]
  onExcludePriority?: (priority: number) => void
  onExcludeLabel?: (label: string) => void
  onExcludeDateFilter?: (filter: DueDateFilter) => void
  onExcludeAttribute?: (key: string) => void
  onExcludeProject?: (projectId: number) => void
  // Signal chips
  signalChips?: { key: string; label: string; count: number; description: string }[]
  selectedSignals?: string[]
  onSignalClick?: (key: string, e: React.MouseEvent) => void
  onSignalLongPress?: (key: string) => void
}) {
  const hasLabels =
    tasks.some((t) => t.labels.length > 0) || selectedLabels.length > 0 || excludedLabels.length > 0

  // Check if the date filter section will actually render badges (needs 2+ buckets or active filters).
  const dateFilterVisible = useMemo(() => {
    if (!timezone || !onToggleDateFilter) return false
    // Always show if date filters are actively selected or excluded
    if (selectedDateFilters.length > 0 || excludedDateFilters.length > 0) return true
    if (tasks.length === 0) return false
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
  }, [timezone, onToggleDateFilter, tasks, selectedDateFilters, excludedDateFilters])

  if (tasks.length === 0) return null

  const aiChipVisible =
    aiMode !== 'off' && onToggleAiFilter && aiInsightsCount != null && aiInsightsCount > 0
  const insightsChipVisible =
    aiMode !== 'off' && (hasInsightsData || insightsGenerating) && onToggleInsights
  // Signal chips visible when Insights chip is ON, or when OFF + user preference allows it
  const signalRowVisible =
    aiMode !== 'off' &&
    signalChips &&
    signalChips.length > 0 &&
    onSignalClick &&
    (insightsActive || insightsSignalChipsVisible)
  const aiRowVisible = aiChipVisible || insightsChipVisible || signalRowVisible

  const hasActiveAttributes =
    (attributeFilters?.size ?? 0) > 0 || (excludedAttributes?.size ?? 0) > 0
  const hasAttributes =
    tasks.some((t) => t.rrule != null || t.auto_snooze_minutes != null) || hasActiveAttributes

  return (
    <div className="relative mb-4">
      <div className="flex flex-col gap-2">
        {/* AI Row: What's Next chip + signal chips — scrollable, visually separated from standard filters */}
        {aiRowVisible && (
          <div className="border-border/40 border-b pb-2">
            <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto">
              {aiChipVisible && (
                <AiChip
                  active={aiFilterActive}
                  loading={aiFilterLoading}
                  count={aiInsightsCount!}
                  onToggleFilter={onToggleAiFilter!}
                />
              )}

              {insightsChipVisible && (
                <>
                  {aiChipVisible && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}
                  <InsightsChip
                    active={insightsActive}
                    loading={insightsGenerating}
                    onToggle={onToggleInsights!}
                  />
                </>
              )}

              {(aiChipVisible || insightsChipVisible) && signalRowVisible && (
                <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />
              )}

              {signalRowVisible && (
                <SignalChipRow
                  chips={signalChips!}
                  selectedSignals={selectedSignals}
                  onClick={onSignalClick!}
                  onLongPress={onSignalLongPress}
                />
              )}
            </div>
          </div>
        )}

        {/* Project row: colored dot chips — wrapping, positioned right under AI row */}
        {projects && onToggleProject && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ProjectFilterBar
              projects={projects}
              tasks={tasks}
              selectedProjects={selectedProjects}
              excludedProjects={excludedProjects}
              onToggleProject={onToggleProject}
              onExclusiveProject={onExclusiveProject}
              onExcludeProject={onExcludeProject}
              todayCounts={todayCounts}
            />
          </div>
        )}

        {/* Row 1: date filter chips — horizontal scroll */}
        {dateFilterVisible && (
          <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto">
            <DueDateFilterBar
              tasks={tasks}
              selectedDateFilters={selectedDateFilters}
              excludedDateFilters={excludedDateFilters}
              onToggleDateFilter={onToggleDateFilter!}
              timezone={timezone!}
              onExclusiveDateFilter={onExclusiveDateFilter}
              onExcludeDateFilter={onExcludeDateFilter}
            />
          </div>
        )}

        {/* Row 2: Priority + label filters — wraps to fit */}
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityFilterBar
            tasks={tasks}
            selectedPriorities={selectedPriorities}
            excludedPriorities={excludedPriorities}
            onTogglePriority={onTogglePriority}
            onExclusivePriority={onExclusivePriority}
            onExcludePriority={onExcludePriority}
          />

          {hasLabels && (
            <LabelFilterBar
              tasks={tasks}
              selectedLabels={selectedLabels}
              excludedLabels={excludedLabels}
              onToggleLabel={onToggleLabel}
              onExclusiveLabel={onExclusiveLabel}
              onExcludeLabel={onExcludeLabel}
            />
          )}

          {hasAttributes && onToggleAttribute && (
            <>
              <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />
              <AttributeFilterBar
                tasks={tasks}
                attributeFilters={attributeFilters ?? new Set()}
                excludedAttributes={excludedAttributes ?? new Set()}
                onToggleAttribute={onToggleAttribute}
                onExclusiveAttribute={onExclusiveAttribute}
                onExcludeAttribute={onExcludeAttribute}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Simplified AI chip for What's Next mode: filter toggle + count only.
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
          : 'bg-muted hover:bg-muted/80 text-blue-700 dark:text-blue-300',
      )}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
      What&apos;s Next
      <span className="opacity-60">{count}</span>
    </button>
  )
}

/** Insights visibility toggle chip (indigo accent). */
function InsightsChip({
  active,
  loading,
  onToggle,
}: {
  active: boolean
  loading: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'flex flex-shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-indigo-600 text-white dark:bg-indigo-500'
          : 'bg-muted hover:bg-muted/80 text-indigo-700 dark:text-indigo-300',
      )}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
      Insights
    </button>
  )
}

/**
 * Signal chip row for Insight mode. Colored chips with multi-select and
 * Cmd+click exclusive select. Click a selected signal again to deselect.
 */
function SignalChipRow({
  chips,
  selectedSignals,
  onClick,
  onLongPress,
}: {
  chips: { key: string; label: string; count: number; description: string }[]
  selectedSignals: string[]
  onClick: (key: string, e: React.MouseEvent) => void
  onLongPress?: (key: string) => void
}) {
  return (
    <>
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
        'flex flex-shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        isSelected
          ? getSignalSelectedClass(chipKey)
          : cn('bg-muted', sig?.text, 'opacity-70 hover:opacity-100'),
      )}
      title={description}
    >
      {sig?.icon}
      {label} ({count})
    </button>
  )
}
