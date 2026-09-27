import { useEffect, useMemo, useRef, useCallback } from 'react'
import { ChevronDown, Filter, Loader2, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import {
  applyTaskFilters,
  FILTER_GROUPS,
  type FilterGroup,
  type TaskFilterCriteria,
} from '@/hooks/useFilterState'
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
 * Filter bar layout. One always-visible control row, and a collapsible block of
 * filter chips beneath it (REDESIGN-V03 §7.3).
 *
 * Collapsed (the default — see `useFilterSection` for the full collapse rules):
 *   Control: [⌄ Filters] [Overdue 9] │ [What's Next 6] [Insights] [Stale 4] [Quick Win 1]
 *
 * Expanded:
 *   Control: [⌃ Filters · 2] [Overdue 9] │ [What's Next 6] [Insights]  ← scrollable
 *            ─────────────────────────────────────────────────────    ← subtle border
 *   Projects: [●Work 42] [●Personal 18] [●Side 6]                    ← wrapping (if 2+ projects)
 *   Row 1:  [Soon 3] [Today 6] [This Week 12]                        ← scrollable
 *   Row 2:  [None 68] [Low 6] [Medium 6] [High 3] ...                ← wrapping
 *
 * The AI chips stay in the control row rather than moving inside the collapse:
 * "What's Next" and the signal chips are the answer to "what now", which is the
 * question §7.3 says the front door must answer, and Insights is a display
 * toggle rather than a filter at all. Only the corpus-slicing chips — project,
 * due date, priority, label, attribute — collapse, and those are exactly the
 * ones `activeFilterCount` counts.
 *
 * The one exception is the pinned **Overdue** chip (Trent, 2026-09-26: one tap
 * to "just the overdue tasks" without opening the filter stack). It sits right
 * after the Filters toggle — before the AI chips, so it never scrolls away —
 * whenever anything is overdue, or while the Overdue filter is on (so it can
 * always be turned off from where it was turned on). It is MOVED, not
 * duplicated: the expanded date row omits its own Overdue chip while the
 * pinned one exists (`omitFilters` below), except when Overdue is EXCLUDED —
 * the pinned chip has no exclude state, so the expanded chip stays to show
 * and clear it. It drives the same `selectedDateFilters` state, and its number
 * is the same date-facet count the top bar's red pill shows
 * (`useDateFacetCounts`, passed in as `pinnedOverdueCount`). See
 * `PinnedOverdueChip` for the tap rules. Because it shows the Overdue
 * selection on its own, an Overdue selection does not auto-expand the section
 * (`hiddenActiveFilterCount` in DashboardClient).
 *
 * Users clear filters by clicking active chips to deselect them.
 */
export function FilterBar({
  tasks,
  expanded,
  onToggleExpanded,
  activeFilterCount = 0,
  pinnedOverdueCount = 0,
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
  aiAvailable = false,
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
  /** Whether the collapsible filter-chip block is showing (§7.3). */
  expanded: boolean
  onToggleExpanded: () => void
  /** Number of active filters inside the collapsible block — drives the badge. */
  activeFilterCount?: number
  /**
   * The pinned Overdue chip's number — the top bar's red-pill count, computed
   * once by the dashboard (`useDateFacetCounts`) so the two cannot disagree.
   */
  pinnedOverdueCount?: number
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
  aiAvailable?: boolean
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

  // Faceted counts (§ see `applyTaskFilters` doc comment in useFilterState.ts):
  // each chip row counts over `tasks` with every OTHER group's filter applied
  // and its OWN group skipped, so e.g. a Work project filter correctly narrows
  // the Today chip's count instead of leaving it showing the whole corpus.
  const filterCriteria: TaskFilterCriteria = useMemo(
    () => ({
      selectedLabels,
      excludedLabels,
      selectedPriorities,
      excludedPriorities,
      selectedDateFilters,
      excludedDateFilters,
      attributeFilters: attributeFilters ?? new Set(),
      excludedAttributes: excludedAttributes ?? new Set(),
      selectedProjects,
      excludedProjects,
    }),
    [
      selectedLabels,
      excludedLabels,
      selectedPriorities,
      excludedPriorities,
      selectedDateFilters,
      excludedDateFilters,
      attributeFilters,
      excludedAttributes,
      selectedProjects,
      excludedProjects,
    ],
  )
  const facetTasks = useMemo(() => {
    const result = {} as Record<FilterGroup, Task[]>
    for (const group of FILTER_GROUPS) {
      result[group] = applyTaskFilters(tasks, filterCriteria, { timezone, skipGroup: group })
    }
    return result
  }, [tasks, filterCriteria, timezone])

  if (tasks.length === 0) return null

  const aiChipVisible =
    aiAvailable &&
    aiMode !== 'off' &&
    onToggleAiFilter &&
    aiInsightsCount != null &&
    aiInsightsCount > 0
  const insightsChipVisible =
    aiAvailable && aiMode !== 'off' && (hasInsightsData || insightsGenerating) && onToggleInsights
  // Signal chips visible when Insights chip is ON, or when OFF + user preference allows it
  const signalRowVisible =
    aiAvailable &&
    aiMode !== 'off' &&
    signalChips &&
    signalChips.length > 0 &&
    onSignalClick &&
    (insightsActive || insightsSignalChipsVisible)
  const aiRowVisible = aiChipVisible || insightsChipVisible || signalRowVisible

  const overdueSelected = selectedDateFilters.includes('overdue')
  const pinnedOverdueVisible =
    !!onExclusiveDateFilter && !!onToggleDateFilter && (pinnedOverdueCount > 0 || overdueSelected)

  // Overdue lives in the control row now (see the layout comment). When the
  // pinned chip is hidden, the expanded chip would have nothing to show
  // either (0 overdue, not selected) — except an EXCLUDED Overdue, which only
  // the expanded chip can display and clear.
  const omitOverdueFromDateRow =
    !!onExclusiveDateFilter && !!onToggleDateFilter && !excludedDateFilters.includes('overdue')

  const hasActiveAttributes =
    (attributeFilters?.size ?? 0) > 0 || (excludedAttributes?.size ?? 0) > 0
  const hasAttributes =
    tasks.some((t) => t.rrule != null || t.auto_snooze_minutes != null) || hasActiveAttributes

  return (
    <div className="relative mb-4">
      <div className="flex flex-col gap-2">
        {/* Control row: Filters toggle + AI chips — always visible, scrollable */}
        <div
          className={cn(
            'scrollbar-hide flex items-center gap-2 overflow-x-auto',
            expanded && 'border-border/40 border-b pb-2',
          )}
        >
          <FiltersToggleChip
            expanded={expanded}
            activeCount={activeFilterCount}
            onToggle={onToggleExpanded}
          />

          {pinnedOverdueVisible && (
            <PinnedOverdueChip
              count={pinnedOverdueCount}
              selected={overdueSelected}
              onSelect={() => onExclusiveDateFilter!('overdue')}
              onDeselect={() => onToggleDateFilter!('overdue')}
            />
          )}

          {aiRowVisible && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

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

        {expanded && (
          <div id="dashboard-filter-chips" className="flex flex-col gap-2">
            {/* Project row: colored dot chips — wrapping */}
            {projects && onToggleProject && (
              <div className="flex flex-wrap items-center gap-1.5">
                <ProjectFilterBar
                  projects={projects}
                  tasks={facetTasks.projects}
                  selectedProjects={selectedProjects}
                  excludedProjects={excludedProjects}
                  onToggleProject={onToggleProject}
                  onExclusiveProject={onExclusiveProject}
                  onExcludeProject={onExcludeProject}
                  timezone={timezone}
                />
              </div>
            )}

            {/* Row 1: date filter chips — horizontal scroll */}
            {dateFilterVisible && (
              <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto">
                <DueDateFilterBar
                  tasks={facetTasks.dateFilters}
                  selectedDateFilters={selectedDateFilters}
                  excludedDateFilters={excludedDateFilters}
                  onToggleDateFilter={onToggleDateFilter!}
                  timezone={timezone!}
                  onExclusiveDateFilter={onExclusiveDateFilter}
                  onExcludeDateFilter={onExcludeDateFilter}
                  omitFilters={omitOverdueFromDateRow ? ['overdue'] : undefined}
                />
              </div>
            )}

            {/* Row 2: Priority + label filters — wraps to fit */}
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityFilterBar
                tasks={facetTasks.priorities}
                selectedPriorities={selectedPriorities}
                excludedPriorities={excludedPriorities}
                onTogglePriority={onTogglePriority}
                onExclusivePriority={onExclusivePriority}
                onExcludePriority={onExcludePriority}
              />

              {hasLabels && (
                <LabelFilterBar
                  tasks={facetTasks.labels}
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
                    tasks={facetTasks.attributes}
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
        )}
      </div>
    </div>
  )
}

/**
 * Toggle for the collapsible filter block (§7.3).
 *
 * Wears the same outline-badge dialect as the due-date chips it reveals, and
 * takes their "included" fill whenever filters are active — an active filter
 * must read as active from the collapsed row alone, so the count badge is not
 * optional decoration. See `useFilterSection` for when it can be collapsed.
 */
function FiltersToggleChip({
  expanded,
  activeCount,
  onToggle,
}: {
  expanded: boolean
  activeCount: number
  onToggle: () => void
}) {
  const hasActive = activeCount > 0
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        'flex-shrink-0 cursor-pointer rounded-sm transition-colors select-none',
        hasActive
          ? 'bg-foreground text-background border-foreground hover:bg-foreground/90'
          : 'hover:bg-muted',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls="dashboard-filter-chips"
        title={expanded ? 'Hide filters' : 'Show filters'}
      >
        <Filter className="size-3" />
        <span className="leading-none">Filters</span>
        {hasActive && <span className="leading-none">&middot; {activeCount}</span>}
        <ChevronDown
          className={cn('size-3 opacity-60 transition-transform', expanded && 'rotate-180')}
        />
      </button>
    </Badge>
  )
}

/**
 * The control row's pinned Overdue chip (see the FilterBar layout comment).
 *
 * Styled exactly like the date chips it was moved out of (`DateChipBadge`:
 * plain outline, solid foreground when on). Not red: Trent, 2026-09-26 —
 * a red chip on every visit read as an alarm; the top bar's red pill
 * already carries the "something is overdue" signal.
 *
 * Tap rules — deliberately simpler than the expanded chips' (no double-click
 * exclude, no long-press): this chip has one job.
 * - Off → apply Overdue EXCLUSIVELY (`exclusiveDateFilter`: Overdue becomes
 *   the only date filter and date excludes clear; project/priority/label
 *   filters stay) — the same call the expanded chip's Cmd+click/long-press
 *   makes and the top bar's red pill makes.
 * - On → turn Overdue off (`toggleDateFilter`), leaving any other date chip
 *   the user picked in the expanded section alone. When Overdue is the only
 *   date filter — the case a tap here produces — that clears the date filter.
 */
function PinnedOverdueChip({
  count,
  selected,
  onSelect,
  onDeselect,
}: {
  count: number
  selected: boolean
  onSelect: () => void
  onDeselect: () => void
}) {
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        'flex-shrink-0 cursor-pointer rounded-sm transition-colors select-none',
        selected
          ? 'bg-foreground text-background border-foreground hover:bg-foreground/90'
          : 'hover:bg-muted',
      )}
    >
      <button
        type="button"
        data-pinned-date-chip="overdue"
        onClick={selected ? onDeselect : onSelect}
        aria-pressed={selected}
        aria-label={
          selected
            ? `Overdue, ${count} — showing only overdue tasks; tap to show all`
            : `Overdue, ${count} — show only overdue tasks`
        }
        title={selected ? 'Show all tasks' : 'Show only overdue tasks'}
      >
        <span className="leading-none">Overdue</span>
        <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
      </button>
    </Badge>
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

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

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
