'use client'

// Selection integration via context
import { HORIZON_WORD } from '@/lib/task-model-words'
import { useCallback, useRef, useState, useEffect } from 'react'
import { ArrowUpDown, ChevronDown, ChevronUp, Layers, Plus } from 'lucide-react'
import { TaskRow } from './TaskRow'
import { SwipeableRow } from './SwipeableRow'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Task, Project } from '@/types'
import type { GroupingMode } from '@/lib/grouping'
import { LABEL_COLORS } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import {
  DECK_GROUP_TITLE,
  isFlatGrouping,
  nowFoldKey,
  shownGroupTasks,
  type SortOption,
  type SortedTaskGroup,
} from '@/lib/task-grouping'
import { isOverdue } from '@/lib/task-counts'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  useDayStart,
  useDayStartKnown,
  useProjectPreviewCount,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { computeSnoozeTime, snoozeOptionNeedsDay } from '@/lib/snooze'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { HorizonValue } from '@/lib/task-segments'
import { justAddedTag } from '@/lib/just-added'
import type { NowSplit } from '@/lib/now-view'

/*
 * How many rows a group shows before "Show all" (§7.3) — only with Now's
 * folds lifted (Show all, a search or a filter): each project group shows the
 * user's `project_preview_count` (Settings → Projects, default 6), via
 * `useProjectPreviewCount`. The cap began as a fixed 10 (2026-09-23:
 * "otherwise it's too hard to scroll through the projects when it's not in
 * unified mode") and became a setting on 2026-09-30. The flat lists (Newest,
 * Unified) are not capped, and neither are Now's relevant rows: there the
 * fold is the one thing that hides rows (`src/lib/now-view.ts`).
 *
 * The point is that the view scales to ANY group size without truncating
 * content — §1.1's founding constraint is that the harness adapts to the scale,
 * so nothing is ever hidden permanently, just collapsed behind one tap.
 */

import { useSnoozeGuard } from '@/hooks/useSnoozeGuard'
import { SnoozeGuardDialog } from '@/components/SnoozeGuardDialog'

import { useSelection, type SelectionContextType } from './SelectionProvider'

interface TaskListProps {
  tasks: Task[]
  /**
   * The user's periods, for a default snooze option of "Next period"
   * (2026-10-10): the swipe and each row's snooze tap resolve it against these.
   * Passed down rather than fetched per row (see `SnoozeMenu`'s slot cache).
   */
  timeSlots?: TimeSlot[]
  /**
   * Show every row of every group — no "Show all" / "Show less" cap. Set
   * while the Overdue filter is on (Trent, 2026-10-01): clearing overdue
   * tasks one by one, a capped group hid the rest and read as "done".
   */
  uncapped?: boolean
  /**
   * `tasks` grouped and sorted — the one visual order, computed by the
   * dashboard (`sortTaskGroups` in `src/lib/task-grouping.ts`) so the keyboard,
   * shift-click ranges and the clipboard follow exactly what is drawn here.
   */
  sortedGroups: SortedTaskGroup[]
  /** The reachable rows' ids in that order (collapsed groups left out). */
  orderedIds: number[]
  projects?: Project[]
  grouping?: GroupingMode
  /**
   * The dashboard's one clock (`useDashboardNow`): the groups and every row's
   * overdue state use it, so they agree with the top bar's pills to the
   * instant — see `src/lib/dashboard-clock.ts`.
   */
  now: Date
  onDone: (taskId: number) => void
  /** Called with (taskId, until) for immediate snooze (single-click, swipe, or menu) */
  onSnooze: (taskId: number, until: string) => void
  onRemoveTarget?: (task: Task) => void
  /**
   * The row's horizon dot menu and its hover Today (2026-10-14), passed to
   * each `TaskRow`. Optional: without them the dot is a mark with a tooltip
   * and the row has no Today button. The dashboard wires them to
   * `actions.handleSaveAllChanges(task.id, { horizon })` and
   * `actions.handleTargetAt` (`useTaskActions`).
   */
  onSetHorizon?: (task: Task, horizon: HorizonValue | null) => void
  onTargetAt?: (task: Task, at?: string) => void
  /** The rows' hover On deck (D2) — `actions.handleDeck`. */
  onDeck?: (task: Task, day: string | null | undefined) => void
  onLabelClick?: (label: string) => void
  onTaskFocus?: (task: Task) => void
  /** Currently keyboard-focused task ID */
  keyboardFocusedId?: number | null
  /** Whether keyboard navigation is active */
  isKeyboardActive?: boolean
  /** Keyboard event handler for list container */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Focus handler for list container */
  onListFocus?: (e: React.FocusEvent) => void
  /** Blur handler for list container */
  onListBlur?: (e: React.FocusEvent) => void
  /** Sort option (the saved preference; drives the sort dropdown only) */
  sortOption: SortOption
  /** Reversed state (the saved preference; drives the sort dropdown only) */
  reversed: boolean
  /** Set sort option (from the dashboard's persisted preferences) */
  setSortOption: (option: SortOption) => void
  /** Desktop click: set keyboard focus (blue glow) without selecting */
  onActivate?: (taskId: number) => void
  /** Desktop double-click: open QuickActionPanel */
  onDoubleClick?: (task: Task) => void
  /** Check if a group is collapsed (lifted from useCollapsedGroups in the dashboard) */
  isCollapsed: (groupLabel: string) => boolean
  /** Toggle collapse for a group (lifted from useCollapsedGroups in the dashboard) */
  toggleCollapse: (groupLabel: string) => void
  /**
   * Now's folds (`src/lib/now-view.ts`), keyed by `nowFoldKey` — lifted into
   * the dashboard (`useNowFolds`) because the keyboard order depends on them.
   * Only read for groups carrying a `now` split.
   */
  isFoldOpen?: (key: string) => boolean
  onToggleFold?: (key: string) => void
  /** Map of taskId -> AI annotation text */
  annotationMap?: Map<number, string>
  /** Whether to show annotation text below task metadata (sparkle icon always shows) */
  showAnnotations?: boolean
  /** Set of task IDs in the What's Next set (for highlight, decoupled from annotations) */
  wnTaskIds?: Set<number>
  /** Whether to show the WN background highlight on tasks in wnTaskIds */
  showWnHighlight?: boolean
  /** Called when user clicks retry on an ai-failed badge */
  onReprocess?: (taskId: number) => void
  /** Optional content rendered on the left side of the sort dropdown row */
  headerLeft?: React.ReactNode
  /** Map of taskId -> insights score (0-100) for AI insights */
  insightsScoreMap?: Map<number, number>
  /** Map of taskId -> signal keys for AI insights */
  insightsSignalMap?: Map<number, string[]>
  /** When true, shows AI Score in sort dropdown (even when disabled/grayed) */
  showAiInsights?: boolean
  /** When true, the AI Score sort option is visible but grayed out */
  aiScoreDisabled?: boolean
  /** Map of taskId -> insights commentary text (shown as indigo Lightbulb annotation) */
  insightsCommentaryMap?: Map<number, string>
  /** Whether unified view is active (toggle callback) */
  onUnifiedChange?: (unified: boolean) => void
  /**
   * Deep-linked from the widget (`?task=<id>&highlight=1`): the one row to
   * scroll to and flash. Group expansion for it is the caller's job (see
   * `DashboardClient`'s `?task=` effect) — `TaskList` only forwards it to the
   * matching `TaskRow`.
   */
  highlightTaskId?: number | null
  /** The deep link's flash has played; it must not play again on a remount. */
  onHighlightDone?: () => void
  /**
   * Just now (`src/lib/just-added.ts`): the dashboard's unfiltered open
   * tasks, which decide which real rows wear the "New" / "Targeted" tag. Null or omitted
   * turns the tag off; the dashboard passes null while searching.
   */
  justAddedSource?: Task[] | null
  /** The "now" the 15-minute window is measured against (`useJustAddedClock`). */
  justAddedNow?: number
  /**
   * Filled in by this list with a function that brings a task's real row on
   * screen and flashes it — what the Just now card (`JustAddedCard`, rendered
   * outside the list) calls on a tap.
   */
  revealRef?: React.MutableRefObject<((task: Task) => void) | null>
  /**
   * NOW'S ON DECK SECTION AT THE TOP (D2 review, 2026-10-20, provisional):
   * the dashboard draws the list in two parts — `'deck'`, the On deck
   * section alone (no sort row, nothing when empty), under the filter row and
   * above the task-segment panel; `'rest'`, everything else, in its usual
   * place. `'all'` (default): one list. The order the keyboard follows
   * (`orderedIds`) puts the section first, as drawn.
   */
  part?: 'all' | 'deck' | 'rest'
  /**
   * The two parts' Just now reveal: the deck part fills it in; the rest part
   * (which holds `revealRef`) hands a task in the section over to it.
   */
  deckRevealRef?: React.MutableRefObject<((task: Task) => void) | null>
}

/** Labels shown on the compact sort button — direction-aware. */
const SORT_BUTTON_LABELS: Record<SortOption, { default: string; reversed: string }> = {
  due_date: { default: 'Soonest', reversed: 'Latest' },
  priority: { default: 'Priority ↓', reversed: 'Priority ↑' },
  title: { default: 'A-Z', reversed: 'Z-A' },
  age: { default: 'Newest', reversed: 'Oldest' },
  modified: { default: 'Modified ↓', reversed: 'Modified ↑' },
  original_due: { default: 'Original Due ↓', reversed: 'Original Due ↑' },
  horizon: { default: 'Horizon ↓', reversed: 'Horizon ↑' },
  ai_insights: { default: 'AI Score ↓', reversed: 'AI Score ↑' },
}

/** Labels shown in the dropdown menu items. */
const SORT_MENU_LABELS: Record<SortOption, string> = {
  due_date: 'Due date',
  priority: 'Priority',
  title: 'A-Z',
  age: 'Date added',
  modified: 'Date modified',
  original_due: 'Original due date',
  horizon: `${HORIZON_WORD}, then deadline`,
  ai_insights: 'AI score',
}

/** One stable empty list, so a caller without periods doesn't change the callbacks' deps. */
const NO_SLOTS: TimeSlot[] = []
const NEVER_OPEN = () => false

export function TaskList({
  tasks,
  timeSlots = NO_SLOTS,
  uncapped = false,
  sortedGroups,
  orderedIds,
  projects = [],
  grouping = 'project',
  now,
  onDone,
  onSnooze,
  onRemoveTarget,
  onSetHorizon,
  onTargetAt,
  onDeck,
  onLabelClick,
  onTaskFocus,
  keyboardFocusedId,
  isKeyboardActive = false,
  onKeyDown,
  onListFocus,
  onListBlur,
  sortOption,
  reversed,
  setSortOption,
  onActivate,
  onDoubleClick,
  isCollapsed,
  toggleCollapse,
  isFoldOpen = NEVER_OPEN,
  onToggleFold,
  annotationMap,
  showAnnotations = false,
  wnTaskIds,
  showWnHighlight = false,
  onReprocess,
  headerLeft,
  insightsScoreMap,
  insightsSignalMap,
  showAiInsights: showAiInsightsProp,
  aiScoreDisabled: aiScoreDisabledProp,
  insightsCommentaryMap,
  onUnifiedChange,
  highlightTaskId,
  onHighlightDone,
  justAddedSource = null,
  justAddedNow = 0,
  revealRef,
  part = 'all',
  deckRevealRef,
}: TaskListProps) {
  // Sort and collapse state are lifted into the dashboard (it owns the sort
  // dropdown's preference and the collapsed-group set), and so is the order
  // itself: `sortedGroups` arrives already sorted, with `effectiveSort`
  // applied (New pins newest-added first whatever the saved sort says). The
  // saved `sortOption`/`reversed` only label the dropdown, which New hides.
  const selection = useSelection()
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()
  const isMobile = useIsMobile()
  const { projectPreviewCount } = useProjectPreviewCount()
  // Project groups preview the user's setting; no cap at all while
  // `uncapped` (the Overdue filter), nor on Now's relevant rows (below).
  const previewCount = uncapped ? Infinity : projectPreviewCount
  const listRef = useRef<HTMLDivElement>(null)

  // Focus the listbox when entering selection mode (e.g., when clicking a task)
  // This ensures arrow keys work immediately after clicking a task
  useEffect(() => {
    if (selection.isSelectionMode && listRef.current) {
      listRef.current.focus({ preventScroll: true })
    }
  }, [selection.isSelectionMode])

  // Swipe-left behavior depends on whether the task is overdue (`isOverdue`):
  // - Overdue: snooze with default option (push forward from now)
  // - Future or no due date: open QuickActionPanel (nothing to "snooze").
  //   A quota is never overdue, so it always gets this edit action (D13).
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()

  // Every snooze originating from this list is a single-task interactive
  // snooze, so all of them route through the §4.3 guard. Bulk sweeps do not
  // come through here — they go via `SnoozeOverdueTrigger`'s bulk endpoint,
  // which must never modal-block.
  const { requestSnooze, dialogProps } = useSnoozeGuard(timezone, onSnooze)

  // Which groups have been expanded past their preview (§7.3). Local
  // state, not persisted: expansion is a momentary "show me the rest", not a
  // preference worth remembering across sessions.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // The real row a tapped just-added preview points at: scrolled to and
  // flashed with the same one-shot highlight a widget deep link uses
  // (`highlighted` on TaskRow). Local state — the deep link's own
  // `highlightTaskId` belongs to the caller and has URL-consumption semantics
  // this does not share.
  const [flashTaskId, setFlashTaskId] = useState<number | null>(null)
  // One flash, two possible sources: clear whichever asked for it.
  const handleHighlightDone = (taskId: number) => {
    if (flashTaskId === taskId) setFlashTaskId(null)
    if (highlightTaskId === taskId) onHighlightDone?.()
  }
  // A flash whose row left mid-flash (completed, filtered away) never reports
  // done; drop it so the row does not flash — and pull the page to it — when
  // it comes back later (say, by Undo). Adjusted during render, like
  // `prevHighlightTaskId` below.
  if (flashTaskId !== null && !tasks.some((t) => t.id === flashTaskId)) {
    setFlashTaskId(null)
  }
  const toggleGroupExpanded = useCallback((label: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  // `highlightTaskId` (the widget's `?task=<id>&highlight=1` link) can land
  // on a row past a group's preview cap. The caller (`DashboardClient`)
  // already un-collapses the group's HEADER via `isCollapsed`/`expand`, and
  // opens Now's fold; this is the other, independent cap — the preview —
  // that only this component's own `expandedGroups` controls.
  //
  // Adjusted during render, not in an effect: this is pure derived state (no
  // external system involved, just `tasks`/`grouping`/etc that are already
  // props), and the lint rule that would otherwise flag it
  // (`react-hooks/set-state-in-effect`) exists precisely to push that case out
  // of `useEffect` — see https://react.dev/learn/you-might-not-need-an-effect
  // ("Adjusting state when a prop changes"). `prevHighlightTaskId` is the
  // guard: without it this would call `setExpandedGroups` on every render.
  const [prevHighlightTaskId, setPrevHighlightTaskId] = useState<number | null>(null)
  if (highlightTaskId !== undefined && highlightTaskId !== prevHighlightTaskId) {
    setPrevHighlightTaskId(highlightTaskId ?? null)
    if (highlightTaskId) {
      const group = sortedGroups.find((g) => g.tasks.some((t) => t.id === highlightTaskId))
      if (group && !expandedGroups.has(group.label)) {
        setExpandedGroups((prev) => new Set(prev).add(group.label))
      }
    }
  }

  const handleSwipeLeft = useCallback(
    (task: Task) => {
      if (isOverdue(task, now)) {
        // A day-dependent default waits for the user's day start.
        if (!dayKnown && snoozeOptionNeedsDay(defaultSnoozeOption)) return
        const until = computeSnoozeTime(
          defaultSnoozeOption,
          timezone,
          morningTime,
          dayStart,
          timeSlots,
        )
        requestSnooze(task, until)
      } else {
        onDoubleClick?.(task)
      }
    },
    [
      defaultSnoozeOption,
      timezone,
      morningTime,
      dayStart,
      dayKnown,
      timeSlots,
      requestSnooze,
      onDoubleClick,
      now,
    ],
  )

  /**
   * The Just now card's tap: bring the task's real row on screen and flash
   * it — unfolding its group, opening Now's fold, and lifting the group's
   * "Show all" cap first if any of them hides it. A task with no row in this
   * view (one a filter hides) opens its quick panel instead, the same thing a
   * tap on a row does on mobile. Handed to the card through
   * `revealRef` after each render, so it always reads this render's groups.
   */
  useEffect(() => {
    const reveal = (task: Task) => {
      const unified = isFlatGrouping(grouping)
      const group = sortedGroups.find((g) => g.tasks.some((t) => t.id === task.id))
      if (!group) {
        onDoubleClick?.(task)
        return
      }
      // The On deck section is the other part's (see `part`).
      if (part === 'rest' && group.deck) {
        deckRevealRef?.current?.(task)
        return
      }
      if (!unified && isCollapsed(group.label)) toggleCollapse(group.label)
      if (group.now) {
        const key = nowFoldKey(group)
        if (group.now.more.some((t) => t.id === task.id) && !isFoldOpen(key)) onToggleFold?.(key)
      } else {
        const index = group.sortedTasks.findIndex((t) => t.id === task.id)
        if (!unified && index >= previewCount && !expandedGroups.has(group.label)) {
          toggleGroupExpanded(group.label)
        }
      }
      setFlashTaskId(task.id)
    }
    if (part === 'deck') {
      if (deckRevealRef) deckRevealRef.current = reveal
    } else if (revealRef) {
      revealRef.current = reveal
    }
  })

  // The groups this part draws (see `part`).
  const groups =
    part === 'all' ? sortedGroups : sortedGroups.filter((g) => !!g.deck === (part === 'deck'))
  if (part === 'deck' && groups.length === 0) return null

  if (tasks.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 text-4xl">&#x2705;</div>
          <h2 className="text-foreground text-xl font-medium">All caught up!</h2>
          <p className="text-muted-foreground mt-1">No tasks due right now.</p>
        </div>
      </>
    )
  }

  // New and Unified are both one flat list (`isFlatGrouping`).
  const isFlat = isFlatGrouping(grouping)
  const isNew = grouping === 'new'

  // Build project lookups for the flat views (project badge + color on each task row)
  const projectNameMap = isFlat ? new Map(projects.map((p) => [p.id, p.name])) : undefined
  const projectColorMap = isFlat ? new Map(projects.map((p) => [p.id, p.color])) : undefined

  const newBadge = (task: Task) =>
    justAddedSource ? justAddedTag(task, justAddedNow, timezone, dayStart) : undefined

  /**
   * `inDeck`: a row of Now's On deck section — no "On deck" just-now pill
   * (the heading says it), and its On deck and Today always shown on touch.
   */
  const renderTaskRow = (task: Task, inDeck = false) => {
    const cancelRef = { current: null as (() => void) | null }
    return (
      <SwipeableRow
        key={task.id}
        onSwipeRight={() => onDone(task.id)}
        onSwipeLeft={() => handleSwipeLeft(task)}
        leftAction={isOverdue(task, now) ? 'snooze' : 'edit'}
        onDragStart={() => cancelRef.current?.()}
        disabled={selection.isSelectionMode}
      >
        <TaskRow
          task={task}
          timeSlots={timeSlots}
          onDone={() => onDone(task.id)}
          onSnooze={(_taskId, until) => requestSnooze(task, until)}
          onRemoveTarget={onRemoveTarget}
          onSetHorizon={onSetHorizon}
          onTargetAt={onTargetAt}
          onDeck={onDeck}
          // `isOverdue` is the Tasks page's one definition (the
          // top bar's pills use it too). §5: it never counts a
          // quota — its period is what is "due", and the bar
          // already says how it stands — so no red stripe there.
          isOverdue={isOverdue(task, now)}
          isSelected={selection.selectedIds.has(task.id)}
          isSelectionMode={selection.isSelectionMode}
          onSelect={() => selection.toggle(task.id)}
          onSelectOnly={() => selection.selectOnly(task.id)}
          onRangeSelect={() => selection.rangeSelect(task.id, orderedIds, keyboardFocusedId)}
          cancelLongPressRef={cancelRef}
          onLabelClick={onLabelClick}
          onFocus={onTaskFocus ? () => onTaskFocus(task) : undefined}
          isKeyboardFocused={isKeyboardActive && !isMobile && task.id === keyboardFocusedId}
          onActivate={onActivate ? () => onActivate(task.id) : undefined}
          onDoubleClick={onDoubleClick ? () => onDoubleClick(task) : undefined}
          annotation={showAnnotations ? annotationMap?.get(task.id) : undefined}
          isAiHighlighted={showWnHighlight && (wnTaskIds?.has(task.id) ?? false)}
          onReprocess={onReprocess ? () => onReprocess(task.id) : undefined}
          insightsScore={insightsScoreMap?.get(task.id)}
          insightsSignals={insightsSignalMap?.get(task.id)}
          insightsCommentary={insightsCommentaryMap?.get(task.id)}
          projectName={projectNameMap?.get(task.project_id)}
          projectColor={projectColorMap?.get(task.project_id)}
          justAddedBadge={inDeck ? undefined : newBadge(task)}
          dayControlsOnTouch={inDeck}
          highlighted={[highlightTaskId, flashTaskId].includes(task.id)}
          onHighlightDone={() => handleHighlightDone(task.id)}
        />
      </SwipeableRow>
    )
  }

  return (
    <div
      ref={part === 'deck' ? undefined : listRef}
      role="listbox"
      aria-label={part === 'deck' ? DECK_GROUP_TITLE : 'Task list'}
      data-deck-list={part === 'deck' ? '' : undefined}
      aria-activedescendant={
        isKeyboardActive && keyboardFocusedId && hasRow(groups, keyboardFocusedId)
          ? `task-row-${keyboardFocusedId}`
          : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onListFocus}
      onBlur={onListBlur}
      className={cn('outline-none', part === 'deck' && 'mb-6')}
    >
      {part !== 'deck' && (
        <div className="mb-4 flex items-center justify-between px-1">
          {headerLeft ?? <div />}
          <div className="flex items-center gap-1">
            {/* New is already flat, so the "Unified" button has nothing to
              switch there — pressing it would leave New for Unified, a
              second flat list in a different order. Hidden in New. */}
            {onUnifiedChange && !isNew && (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-6 px-2 text-xs',
                  isFlat
                    ? 'text-foreground bg-muted font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onUnifiedChange(!isFlat)}
                title={isFlat ? 'Show grouped again' : 'Show all tasks in one list'}
              >
                <Layers className="mr-1 size-3" />
                Unified
              </Button>
            )}
            {/* New ignores the sort preference (`effectiveSort`): its order is
              what makes it New. A sort control there would either do
              nothing (confusing) or turn New into a different view, so it
              is replaced by a plain caption that says what the order is —
              not a disabled dropdown, which would read as broken. The
              caption sits where the dropdown was so the row doesn't jump
              when switching views. */}
            {isNew ? (
              <span
                data-new-order
                className="text-muted-foreground flex h-6 items-center px-2 text-xs"
              >
                <ArrowUpDown className="mr-1 size-3" />
                Newest added
              </span>
            ) : (
              <SortDropdown
                sortOption={sortOption}
                reversed={reversed}
                onSort={setSortOption}
                showAiInsights={showAiInsightsProp ?? !!insightsScoreMap}
                aiScoreDisabled={aiScoreDisabledProp ?? false}
              />
            )}
          </div>
        </div>
      )}
      <div className={isFlat ? 'space-y-1' : 'space-y-6'}>
        {groups.map((group) => {
          const { sortedTasks, now: nowSplit } = group
          const collapsed = !isFlat && isCollapsed(group.label)

          // Now (`src/lib/now-view.ts`): the relevant rows, uncapped, then the
          // fold. Open, the rest of the project follows as ordinary rows.
          const foldKey = nowFoldKey(group)
          const foldOpen = !!nowSplit && isFoldOpen(foldKey)
          // The rows on screen — what the heading's and the checkbox's
          // select-all take: a shut fold's rows are not on screen.
          const shownTasks = shownGroupTasks(group, foldOpen)

          // §7.3: show the first N, with everything else one tap away. Nothing
          // is ever truncated permanently — §1.1's constraint is that the
          // harness adapts to the scale, so a 40-item project stays fully
          // reachable while the list still reads at a glance. Project groups
          // preview at the user's `project_preview_count` while Now's folds
          // are lifted; the flat lists and Now's own rows show everything.
          const previewed = isPreviewed(group, isFlat)
          const isExpanded = expandedGroups.has(group.label)
          const visibleTasks =
            previewed && !isExpanded ? sortedTasks.slice(0, previewCount) : shownTasks
          const hiddenCount = previewed ? sortedTasks.length - visibleTasks.length : 0

          return (
            // `data-task-group` + `scroll-below-header`: the dashboard's
            // overdue/today jump scrolls the FIRST of these to just under the
            // top bar (`useJumpToTaskList`).
            <section
              key={group.label}
              data-task-group
              data-deck-section={group.deck ? '' : undefined}
              className="scroll-below-header"
            >
              {/* Skip group header in unified mode — all tasks render in a single flat list */}
              {!isFlat && (
                <div
                  className={`flex min-h-7 items-center justify-between px-1 ${!collapsed ? 'mb-2' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleCollapse(group.label)}
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${groupTitle(group)}`}
                      className="text-muted-foreground hover:text-foreground -mr-1.5 flex items-center justify-center p-0.5 transition-colors"
                    >
                      <ChevronDown
                        className={`size-3 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                      />
                    </button>
                    {!collapsed && selection.isSelectionMode && (
                      <GroupCheckbox
                        groupTaskIds={shownTasks.map((t) => t.id)}
                        selection={selection}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        // When collapsed, clicking the label expands the group
                        if (collapsed) {
                          toggleCollapse(group.label)
                          return
                        }
                        const ids = shownTasks.map((t) => t.id)
                        if (selection.isSelectionMode) {
                          // Toggle: if all selected, deselect all; otherwise select all
                          const allSelected = ids.every((id) => selection.selectedIds.has(id))
                          if (allSelected) {
                            selection.removeAll(ids)
                          } else {
                            selection.addAll(ids)
                          }
                        } else {
                          // Enter selection mode and select all in this group
                          selection.addAll(ids)
                        }
                      }}
                      className="text-muted-foreground hover:text-foreground text-xs font-semibold tracking-wider uppercase transition-colors"
                    >
                      <GroupHeadingText group={group} />
                      <GroupCount total={group.tasks.length} nowSplit={nowSplit} />
                    </button>
                  </div>
                </div>
              )}
              {!collapsed && (
                <div className="space-y-1">
                  {visibleTasks.map((task) => renderTaskRow(task, !!group.deck))}
                  {nowSplit && (
                    <NowFoldRow
                      projectLabel={group.label}
                      moreCount={nowSplit.more.length}
                      nothingRelevant={nowSplit.relevant.length === 0}
                      open={foldOpen}
                      onToggle={() => onToggleFold?.(foldKey)}
                    />
                  )}
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleGroupExpanded(group.label)}
                      className="text-muted-foreground hover:text-foreground w-full rounded-lg py-2 text-xs font-medium transition-colors"
                    >
                      Show all {sortedTasks.length}
                      <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
                    </button>
                  )}
                  {previewed && isExpanded && sortedTasks.length > previewCount && (
                    <button
                      type="button"
                      onClick={() => toggleGroupExpanded(group.label)}
                      className="text-muted-foreground hover:text-foreground w-full rounded-lg py-2 text-xs font-medium transition-colors"
                    >
                      Show less
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
      <SnoozeGuardDialog {...dialogProps} />
    </div>
  )
}

/**
 * Whether a group is capped at the preview count: project groups with Now's
 * folds lifted only — not the flat lists, not Now's own rows, and not Now's
 * On deck section (D2, `withDeckSection`).
 */
function isPreviewed(group: SortedTaskGroup, isFlat: boolean): boolean {
  return !isFlat && !group.now && !group.deck
}

/** Whether one of these groups holds the task. */
function hasRow(groups: SortedTaskGroup[], id: number): boolean {
  return groups.some((g) => g.tasks.some((t) => t.id === id))
}

/** A group's name on screen: the project's, or "On deck" for Now's deck section. */
function groupTitle(group: SortedTaskGroup): string {
  return group.deck ? DECK_GROUP_TITLE : group.label
}

/**
 * A group heading's words. A PROJECT heading is a tag in its project's color
 * (2026-09-23, option C of four rendered: "I lose track of what color is for
 * what"). The same tinted pair labels use, so it reads the same in light and
 * dark. A project with no color keeps the plain heading, and so does Now's
 * On deck section (D2, spec rule 9 — a section, not a project).
 */
function GroupHeadingText({ group }: { group: SortedTaskGroup }) {
  if (!group.color) return <>{groupTitle(group)}</>
  return (
    <span
      data-project-heading-tag
      className={cn(
        'rounded-md px-2 py-0.5',
        LABEL_COLORS[group.color].bg,
        LABEL_COLORS[group.color].text,
      )}
    >
      {group.label}
    </span>
  )
}

/**
 * A group heading's count: the group's size, or in Now "1 of 5" — the
 * project's rows relevant now, of its open tasks (mockup E1).
 */
function GroupCount({ total, nowSplit }: { total: number; nowSplit?: NowSplit }) {
  if (!nowSplit) return <span className="text-muted-foreground/60 ml-2">{total}</span>
  return (
    <span
      data-now-count
      className="text-muted-foreground/60 ml-2 font-normal tracking-normal normal-case"
    >
      {nowSplit.relevant.length} of {total}
    </span>
  )
}

/**
 * Now's fold row under a project's relevant rows (mockup E1): shut, a dashed
 * "+ N more in <Project>" — with "· nothing due" when the project has nothing
 * relevant, so a project that is all fold still says why it is quiet; open, a
 * "Show fewer" row after the rest of the project's rows. Nothing when every
 * row of the project is relevant. See `src/lib/now-view.ts`.
 */
function NowFoldRow({
  projectLabel,
  moreCount,
  nothingRelevant,
  open,
  onToggle,
}: {
  projectLabel: string
  moreCount: number
  nothingRelevant: boolean
  open: boolean
  onToggle: () => void
}) {
  if (moreCount === 0) return null
  if (open) {
    return (
      <button
        type="button"
        data-now-fold="open"
        onClick={onToggle}
        aria-expanded
        className="border-border text-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-xs font-medium transition-colors"
      >
        <ChevronUp className="size-3.5" aria-hidden />
        Show fewer
      </button>
    )
  }
  return (
    <button
      type="button"
      data-now-fold="shut"
      onClick={onToggle}
      aria-expanded={false}
      className="border-border text-foreground hover:bg-muted/50 flex w-full items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 text-left text-xs transition-colors"
    >
      <Plus className="size-3.5" aria-hidden />
      <span className="font-medium">
        {moreCount} more in {projectLabel}
      </span>
      {nothingRelevant && <span className="text-muted-foreground">· nothing due</span>}
    </button>
  )
}

function GroupCheckbox({
  groupTaskIds,
  selection,
}: {
  groupTaskIds: number[]
  selection: SelectionContextType
}) {
  const selectedCount = groupTaskIds.filter((id) => selection.selectedIds.has(id)).length
  const allSelected = selectedCount === groupTaskIds.length
  const someSelected = selectedCount > 0 && !allSelected

  return (
    <Checkbox
      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
      onCheckedChange={() => {
        if (allSelected) {
          selection.removeAll(groupTaskIds)
        } else {
          selection.addAll(groupTaskIds)
        }
      }}
      className="size-3.5"
      aria-label={allSelected ? 'Deselect all in group' : 'Select all in group'}
    />
  )
}

export function SortDropdown({
  sortOption,
  reversed,
  onSort,
  showAiInsights = false,
  aiScoreDisabled = false,
}: {
  sortOption: SortOption
  reversed: boolean
  onSort: (option: SortOption) => void
  showAiInsights?: boolean
  /** When true, the AI score option is visible but grayed out and non-interactive */
  aiScoreDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const isTouchRef = useRef(false)
  const label = reversed
    ? SORT_BUTTON_LABELS[sortOption].reversed
    : SORT_BUTTON_LABELS[sortOption].default

  const options: SortOption[] = showAiInsights
    ? ['ai_insights', 'horizon', 'due_date', 'priority', 'title', 'age', 'modified', 'original_due']
    : ['horizon', 'due_date', 'priority', 'title', 'age', 'modified', 'original_due']

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-6 px-2 text-xs"
          onPointerDown={(e) => {
            isTouchRef.current = e.pointerType === 'touch'
            if (e.pointerType === 'touch') {
              e.preventDefault()
            }
          }}
          onClick={() => {
            if (isTouchRef.current) {
              setOpen((prev) => !prev)
              isTouchRef.current = false
            }
          }}
        >
          <ArrowUpDown className="mr-1 size-3" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => {
          const isActive = sortOption === option
          const isDisabled = option === 'ai_insights' && aiScoreDisabled
          const itemLabel =
            isActive && reversed ? SORT_BUTTON_LABELS[option].reversed : SORT_MENU_LABELS[option]
          // Selecting the active option will toggle direction, so show what it will become
          const hint = isActive
            ? `→ ${reversed ? SORT_BUTTON_LABELS[option].default : SORT_BUTTON_LABELS[option].reversed}`
            : null
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => {
                if (!isDisabled) onSort(option)
              }}
              className={cn(
                isActive ? 'font-semibold' : '',
                isDisabled ? 'pointer-events-none opacity-40' : '',
              )}
            >
              {itemLabel}
              {hint && (
                <span className="text-muted-foreground ml-auto pl-3 text-[10px] font-normal">
                  {hint}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
