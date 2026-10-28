'use client'

import { useRef, useCallback, useEffect, useState } from 'react'
import { useLongPress, useSimpleLongPress } from '@/hooks/useLongPress'
import Link from 'next/link'
import { DateTime } from 'luxon'
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  Clock,
  Eye,
  FolderOpen,
  HelpCircle,
  Repeat,
  Sparkles,
  StickyNote,
  Timer,
  TimerOff,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { scrollRowIntoView } from '@/lib/scroll-row-into-view'
import { isTracked, taskPeriodLabel, trackState } from '@/lib/track'
import { formatDueTimeParts } from '@/lib/format-date'
import {
  ageLabel,
  attemptsOffer,
  effectiveAttempts,
  isPastDeadline,
  targetReset,
  type HorizonValue,
} from '@/lib/task-segments'
import { REMOVE_TARGET } from '@/lib/task-model-words'
import { cornerWidth, offersTargetToday, showsHorizonDot, type PriorityTab } from '@/lib/row-corner'
import { priorityRowStyles } from '@/lib/priority-display'
import { RowCorner } from '@/components/RowCorner'
import { TargetTodayButton } from '@/components/TargetMenu'
import { OnDeckButton } from '@/components/OnDeckButton'
import { DeadlineChip } from '@/components/DeadlineChip'
import { deckReplaces, offersDeck, todayReplaces } from '@/lib/deck-menu'
import { TargetTimeText } from '@/components/TargetTimeText'
import { TimeChip } from '@/components/TimeChip'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { queuedRepeatOccurrence } from '@/lib/editor-target-labels'
import { useTimezone } from '@/hooks/useTimezone'
import {
  useLabelConfig,
  usePriorityDisplay,
  useTaskQueue,
  useDayStart,
  useDayStartKnown,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { LABEL_COLORS } from '@/lib/label-colors'
import { LabelBadges } from '@/components/LabelBadges'
import { computeSnoozeTime, snoozeOptionNeedsDay } from '@/lib/snooze'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import type { Task, LabelColor } from '@/types'

/**
 * TaskRow visual reference — complete rendered examples:
 *
 *   Line 1: [title]
 *   Line 2: [relative time] · [absolute time] · [recurrence text] · [deadline]
 *   Line 3: [priority] [↻] [⏱] [📝] [labels] [project]
 *
 * Due soon (< 3h, shows both relative + absolute):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ ○  Buy groceries                                       │
 *   │    in 47m · 2:25 PM                                    │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Recurring + labels:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ ○  Morning standup  ↻  [work]                          │
 *   │    in 1h 30m · 9:00 AM · Weekdays                      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Overdue (red left border, relative "ago" + absolute time):
 *   ┃─────────────────────────────────────────────────────────┐
 *   ┃ ○  Pay rent                                             │
 *   ┃    3h ago · 9:00 AM                                     │
 *   ┃─────────────────────────────────────────────────────────┘
 *
 * Overdue times: <1m ago · 5:00 PM | 3h ago · 9 AM | yesterday · 5 PM | 3d ago · Jan 30 5 PM
 * Future times:  in 47m · 5:00 PM · Tomorrow 9 AM · Wed 9 AM · Feb 11 9 AM
 * Left border:   red=past deadline, plum=over target, none=default (no
 *                "snoozed" state since 2026-10-12, §6)
 * Snooze button:  desktop only (hover) — mobile uses swipe
 */

interface TaskRowProps {
  task: Task
  /** The user's periods, so a "Next period" default snooze resolves (see TaskList). */
  timeSlots?: TimeSlot[]
  onDone: () => void
  /** Called with (taskId, until) for immediate snooze */
  onSnooze: (taskId: number, until: string) => void
  /** Remove the target (2026-10-10) — offered in the snooze hold menu. */
  onRemoveTarget?: (task: Task) => void
  /**
   * Change the horizon from the corner dot's menu (2026-10-14). Without it
   * the dot is drawn, with its tooltip, but opens nothing.
   */
  onSetHorizon?: (task: Task, horizon: HorizonValue | null) => void
  /**
   * Target the task (2026-10-14, the hover "Today" button): no `at` is "today"
   * at the server's Snooze-all time; an `at` is a time chosen from the Target
   * menu. Without it the row has no Today button.
   */
  onTargetAt?: (task: Task, at?: string) => void
  /**
   * On deck (D2, 2026-10-20, the hover On deck beside Today): `day`
   * undefined = today, a yyyy-MM-dd day, null = take off deck. Without it, or
   * with the task queue off, the row has no On deck button.
   */
  onDeck?: (task: Task, day: string | null | undefined) => void
  /**
   * A row of Now's On deck section (D2 review, phone-first): its On deck
   * (filled icon) and Today are always shown, on touch too — not hover-only — so a
   * deck can be taken off, or targeted, from a phone. Other rows keep the
   * mouse-only hover controls.
   */
  dayControlsOnTouch?: boolean
  isOverdue?: boolean
  isSelected?: boolean
  isSelectionMode?: boolean
  onSelect?: () => void
  onSelectOnly?: () => void
  onRangeSelect?: () => void
  cancelLongPressRef?: React.MutableRefObject<(() => void) | null>
  onLabelClick?: (label: string) => void
  onFocus?: () => void
  /** True when this task has keyboard focus (via arrow navigation) */
  isKeyboardFocused?: boolean
  /** Desktop click: just set keyboard focus (blue glow), no selection */
  onActivate?: () => void
  /** Desktop double-click: open QuickActionPanel (alternative to entering selection mode) */
  onDoubleClick?: () => void
  /** Optional annotation line below metadata (e.g., AI reason from What's Next) */
  annotation?: string
  /** When true, renders a sparkle icon before the title indicating AI insight */
  isAiHighlighted?: boolean
  /** Called when the user clicks the retry button on an ai-failed badge */
  onReprocess?: () => void
  /** AI insights score (0-100) */
  insightsScore?: number
  /** AI insights signal keys */
  insightsSignals?: string[]
  /** Per-task insights commentary — shown as indigo text with Lightbulb icon */
  insightsCommentary?: string
  /** Project name shown as a subtle badge on line 1 (used in unified view) */
  projectName?: string
  /** Project color for the project badge dot (used in unified view) */
  projectColor?: LabelColor | null
  /**
   * Just now (`src/lib/just-added.ts`): the task was created — or targeted
   * from a task segment — in the last 15 minutes, so it is listed in the Just
   * now card, and this is the small tag ("New", or "Targeted") that makes its
   * real row easy to spot where it lives: after a run of Today taps the
   * targeted rows sit among every other task over target, and this is how the
   * one to re-target is found. Neutral on purpose: a fact to notice, not a
   * state that needs acting on.
   */
  justAddedBadge?: string
  /**
   * Deep-linked from the widget (`?task=<id>&highlight=1`): scroll to it and
   * flash it once, mirroring `RemindersView`'s `ReminderRow` — see the
   * `ResizeObserver` effect below for why the dashboard needs an effect
   * where `ReminderRow` gets away with a plain ref.
   */
  highlighted?: boolean
  /** The deep link's flash has played; it must not play again on a remount. */
  onHighlightDone?: () => void
}

/** Signal icon + color mapping for AI insights indicators */
export const SIGNAL_ICONS: Record<
  string,
  { icon: React.ReactNode; label: string; bg: string; text: string }
> = {
  review: {
    icon: <Eye className="size-3" />,
    label: 'Review',
    bg: 'bg-indigo-100 dark:bg-indigo-900/40',
    text: 'text-indigo-700 dark:text-indigo-300',
  },
  stale: {
    icon: <Clock className="size-3" />,
    label: 'Stale',
    bg: 'bg-zinc-100 dark:bg-zinc-800',
    text: 'text-zinc-600 dark:text-zinc-400',
  },
  act_soon: {
    icon: <AlertTriangle className="size-3" />,
    label: 'Act Soon',
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    text: 'text-amber-700 dark:text-amber-300',
  },
  quick_win: {
    icon: <Zap className="size-3" />,
    label: 'Quick Win',
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-700 dark:text-green-300',
  },
  vague: {
    icon: <HelpCircle className="size-3" />,
    label: 'Vague',
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-700 dark:text-blue-300',
  },
  misprioritized: {
    icon: <ArrowUpDown className="size-3" />,
    label: 'Misprioritized',
    bg: 'bg-purple-100 dark:bg-purple-900/40',
    text: 'text-purple-700 dark:text-purple-300',
  },
}

/**
 * Color class for the insights score badge: one neutral gray in three depths,
 * never red/amber/green (2026-10-11 — red means a passed deadline, nothing
 * else). A higher score reads a little stronger; the number carries the rest.
 */
function getScoreColor(score: number): string {
  if (score >= 70) return 'bg-foreground/15 text-foreground'
  if (score >= 40) return 'bg-foreground/10 text-foreground/80'
  return 'bg-muted text-muted-foreground'
}

/** One stable empty list, so a row without periods keeps its snooze callback's identity. */
const NO_SLOTS: TimeSlot[] = []

export function TaskRow({
  task,
  timeSlots = NO_SLOTS,
  onDone,
  onSnooze,
  onRemoveTarget,
  onSetHorizon,
  onTargetAt,
  onDeck,
  dayControlsOnTouch = false,
  isOverdue,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onSelectOnly,
  onRangeSelect,
  cancelLongPressRef,
  onLabelClick,
  onFocus,
  isKeyboardFocused = false,
  onActivate,
  onDoubleClick,
  annotation,
  isAiHighlighted = false,
  onReprocess,
  insightsScore,
  insightsSignals,
  insightsCommentary,
  projectName,
  projectColor,
  justAddedBadge,
  highlighted = false,
  onHighlightDone,
}: TaskRowProps) {
  const timezone = useTimezone()
  // The user's day boundary ("Day starts at" PR 2): "Today" / "Tomorrow" on
  // the row, and the defaults' "tomorrow", are OpenTask days.
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()
  const { labelConfig } = useLabelConfig()
  const { priorityDisplay } = usePriorityDisplay()
  const queue = useTaskQueue()
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)

  // The row's snooze button: a tap snoozes an overdue task by the default
  // option; a tap on a task not yet due opens the menu instead (an instant
  // snooze would pull a future due date back to now + offset); a hold (400ms)
  // opens the menu. `useSimpleLongPress` — the snooze-all trigger's hook —
  // counts only the primary button, so a right-click no longer snoozes (it
  // did, from its own hand-rolled copy of this timer). Its `onClick` is the
  // keyboard path (Enter/Space) and swallows the click a pointer press
  // already handled.
  //
  // Every handler stops propagation: the press must not reach the row, whose
  // own pointer handlers select, open and long-press the task.
  const openSnoozeMenu = useCallback(() => setSnoozeMenuOpen(true), [])
  const snoozeNow = useCallback(() => {
    // Not due yet — or a day-dependent default ("tomorrow") before the
    // browser knows the user's day start: the menu, not a guess.
    if (!isOverdue || (!dayKnown && snoozeOptionNeedsDay(defaultSnoozeOption))) {
      setSnoozeMenuOpen(true)
      return
    }
    onSnooze(
      task.id,
      computeSnoozeTime(defaultSnoozeOption, timezone, morningTime, dayStart, timeSlots),
    )
  }, [
    task.id,
    defaultSnoozeOption,
    timezone,
    morningTime,
    dayStart,
    dayKnown,
    timeSlots,
    onSnooze,
    isOverdue,
  ])
  const snoozePress = useSimpleLongPress({ onLongPress: openSnoozeMenu, onShortPress: snoozeNow })

  /**
   * `highlighted` (the widget's `?task=<id>&highlight=1` link): keep the row
   * centred for as long as the highlight is alive, not just once on mount.
   *
   * Unlike RemindersView's `?reminder=<id>` (a plain `ref={highlighted ?
   * scrollRowIntoView : undefined}` — see `scrollRowIntoView`'s doc comment),
   * the dashboard has several panels — Reminders, Track, AI Insights
   * annotations — that fetch and mount AFTER this row does, each one pushing
   * the row further down the page. A single scroll on mount goes stale the
   * moment any of them lands; found by browser-verifying against Trent's
   * real dev account, where the row scrolled off-screen again within a
   * second of landing on it.
   *
   * A `ResizeObserver` on `document.body` re-centers on every layout change
   * instead of guessing a delay — no timeout, no retry count, just a
   * response to the actual event (the page's height changing). It also
   * fires once immediately on `observe()`, so the initial scroll comes for
   * free. Torn down the moment the highlight's flash ends (`onHighlightDone`
   * flips `highlighted` false via `onAnimationEnd` below), so it never
   * outlives the thing it's centering.
   */
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlighted) return
    const ro = new ResizeObserver(() => scrollRowIntoView(rowRef.current))
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [highlighted])

  // Long-press: range-select when already in selection mode, otherwise toggle
  const longPressAction = isSelectionMode && onRangeSelect ? onRangeSelect : onSelect
  const pointer = useLongPress({ onLongPress: longPressAction, trackDoubleClick: true })

  // Expose long-press cancel function to parent (SwipeableRow)
  useEffect(() => {
    if (cancelLongPressRef) {
      cancelLongPressRef.current = pointer.onPointerLeave
    }
  }, [cancelLongPressRef, pointer.onPointerLeave])

  /**
   * Selection behavior by input type:
   *
   * | Context              | Input                   | Action                                     |
   * |----------------------|-------------------------|--------------------------------------------|
   * | Not in selection mode| Desktop click           | activate - show blue glow only (no select) |
   * | Not in selection mode| Desktop double-click    | onDoubleClick - open QuickActionPanel      |
   * | Not in selection mode| Mobile tap              | onDoubleClick - open QuickActionPanel      |
   * | In selection mode    | Desktop plain click     | selectOnly - replace selection             |
   * | In selection mode    | Desktop Cmd/Ctrl+click  | toggle - accumulate selection              |
   * | In selection mode    | Desktop Shift+click     | rangeSelect - select range                 |
   * | In selection mode    | Mobile tap              | toggle - accumulate (no blue glow)         |
   *
   * Rationale: Desktop click just shows focus (blue glow) like Finder - you use Space to
   * actually select. Double-click opens QuickActionPanel for quick edits.
   * Long-press enters selection mode on both desktop and mobile. Mobile tap opens
   * the QuickActionPanel (same as desktop double-click) for quick edits.
   * This separates "where you are" (focus/blue glow) from "what's selected" (checkboxes).
   */
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (pointer.didFire()) {
        e.preventDefault()
        return
      }

      e.preventDefault()

      // Double-click opens QuickActionPanel (desktop quick edit)
      if (!isSelectionMode && pointer.didDoubleClick() && onDoubleClick) {
        onDoubleClick()
        return
      }

      // In selection mode, also move keyboard focus (blue glow) to the clicked task
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect()
        onActivate?.()
      } else if ((e.metaKey || e.ctrlKey) && onSelect) {
        onSelect()
        onActivate?.()
      } else if (isSelectionMode && pointer.wasTouch() && onSelect) {
        // Touch in selection mode: toggle selection only, no keyboard focus (blue glow).
        // Keyboard focus is a desktop affordance (arrow keys, Space, Cmd+D) with no
        // purpose on mobile — showing it on touch just creates visual noise.
        onSelect()
      } else if (isSelectionMode && onSelectOnly) {
        onSelectOnly()
        onActivate?.()
      } else if (pointer.wasTouch() && onDoubleClick) {
        onDoubleClick()
      } else if (onActivate) {
        onActivate()
      }
    },
    [isSelectionMode, onSelect, onSelectOnly, onRangeSelect, onActivate, onDoubleClick, pointer],
  )

  // The user's Priority Display settings, read through the rule every row
  // shares (`priorityRowStyles`: reminders, quota prompts and chips too).
  const pri = priorityRowStyles(task.priority, priorityDisplay)
  const isAiProcessing = task.labels.includes('ai-to-process')
  const tracked = isTracked(task)
  const pastDeadline = !tracked && isPastDeadline(task.deadline_at, new Date())
  // §5: a quota's row states its count where a task states its due time; the
  // controls live in the Track panel on the Tasks page, not on every row.
  // A repeating task waiting in the task queue names the occurrence it stands
  // for, as on its queue row (`queuedRepeatOccurrence`, 2026-10-20) — only
  // with the queue switch on.
  const queuedOccurrence = queue.enabled ? queuedRepeatOccurrence(task) : null
  const metaSegments = tracked
    ? trackedMetaSegments(task)
    : buildMetaSegments(task, timezone, dayStart, isOverdue, queuedOccurrence)
  // ATTEMPTS (spec §7): local days over target, read here with the same rule
  // the server uses, so the row shows "1×" the moment the target passes
  // without a refetch. At 3× the row OFFERS to drop the target (never does it
  // on its own): "Remove target?" — a deadline task too since 2026-10-22 (it
  // goes on the deadlines page); nothing on a repeating task.
  //
  // The task queue (resolution 1, PR 3): with the SERVER's switch on
  // (`useTaskQueue`, from GET /api/user/preferences) "Remove target?" is
  // retired on a strippable one-off (below High, no deadline) — the rollover
  // takes its target off on its own — and attempts count OpenTask days from
  // the user's rollover time, the server's own count (B7, its early-morning
  // pick rule included). With the switch off: calendar days and the offer,
  // exactly as before the queue.
  // Until the preferences have loaded the switch is unknown (`queue.loaded`):
  // the server's stored count stands, and no offer is drawn, so nothing
  // changes when they land.
  const attempts = queue.loaded
    ? effectiveAttempts(task, timezone, new Date(), queue.attemptsRolloverTime).attempts
    : (task.attempts ?? 0)
  const offer =
    queue.loaded && onRemoveTarget && !isSelectionMode && !tracked
      ? attemptsOffer({ ...task, attempts }, new Date(), { queue: queue.enabled })
      : null
  const corner = rowCorner({
    task,
    attempts: !tracked && task.due_at !== null ? attempts : 0,
    priorityTab: pri.tab,
    isSelectionMode,
  })
  // The target time is a control (Remove target / Move…, `TargetTimeText`)
  // wherever the row can act on it: not in selection mode, where a press on
  // the row selects.
  const timeControl = !isSelectionMode && !tracked && task.due_at !== null && !queuedOccurrence
  const showToday = !isSelectionMode && !!onTargetAt && offersTargetToday(task)
  // On deck (spec rule 8) beside Today — the queue switch on, the same rows
  // as Today plus any task already on deck (its active button takes it off).
  const showDeck = !isSelectionMode && !!onDeck && queue.loaded && queue.enabled && offersDeck(task)
  const cornerPresent = corner.dot || corner.attempts >= 1 || corner.priority !== null
  // Filter ai-to-process from visible label count (animation conveys that state)
  const visibleLabelCount = task.labels.filter((l) => l !== 'ai-to-process').length
  const hasLabels = visibleLabelCount > 0
  const hasIndicators =
    insightsScore !== undefined ||
    !!task.rrule ||
    task.auto_snooze_minutes !== null ||
    !!(task.notes && task.notes.trim()) ||
    hasLabels ||
    !!projectName

  const rowProps = {
    id: `task-row-${task.id}`,
    role: 'option',
    'aria-selected': isSelected,
    tabIndex: -1,
    onClick: handleClick,
    onMouseEnter: onFocus,
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(), // Prevent triggering list's onMouseInteraction
    // A press on one of the row's own controls (the corner dot, the target
    // time, the hover Today — `data-no-row-press`, their menus included) is
    // not the start of a long-press: holding it must not select the row.
    // They cannot stop the pointerdown instead — see `TargetTimeText`.
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as Element).closest('[data-no-row-press]')) return
      pointer.onPointerDown(e)
    },
    onPointerUp: pointer.onPointerUp,
    onPointerMove: pointer.onPointerMove,
    onPointerLeave: pointer.onPointerLeave,
    onPointerCancel: pointer.onPointerUp,
  }

  return (
    <div
      {...rowProps}
      ref={rowRef}
      data-task-highlight={highlighted ? '' : undefined}
      onAnimationEnd={(e) => {
        // Filtered: this row can also run `animate-ai-processing`, whose
        // `animationend` must not spend the one-shot highlight early.
        if (e.target === e.currentTarget && e.animationName === 'row-highlight') {
          onHighlightDone?.()
        }
      }}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg p-3 select-none',
        // min-h-[62px] matches the natural height when snooze button is present:
        // snooze button (36px h-9) + padding (24px) + border (2px) = 62px
        // This prevents single-line tasks from shrinking when entering selection mode.
        'bg-card min-h-[62px] border',
        'hover:border-border/80 transition-colors',
        isAiHighlighted && !isSelected && 'bg-blue-50/50 dark:bg-blue-950/20',
        // A 4px state border is 3px wider than the plain 1px one, so the
        // padding on that side gives the 3px back (12px - 3px = 9px). Without
        // it the circle and title of an over-target row sat 3px to the right
        // of a plain row's, a visible zigzag down the list.
        // The hover:border-l-* repeats keep the state colour on hover: the
        // row's `hover:border-border/80` sets all four sides and would
        // otherwise turn the plum left edge grey under the pointer.
        // A passed deadline outranks it (red = a passed deadline, and only
        // that): the stripe goes red beside the red "past deadline" line
        // rather than plum (2026-10-11 visual QA). The blue "snoozed" stripe
        // went with the snooze state (§6, 2026-10-12).
        pastDeadline && 'border-l-destructive hover:border-l-destructive border-l-4 pl-[9px]',
        !pastDeadline &&
          isOverdue &&
          'border-l-over-target hover:border-l-over-target border-l-4 pl-[9px]',
        // Right border for priority (user preference), with the same give-back
        pri.border && cn('border-r-4 pr-[9px]', pri.border),
        isSelected && 'ring-ring bg-accent ring-2',
        isSelectionMode && 'cursor-pointer',
        // AI enrichment in progress — subtle border pulse. Not while the row is
        // flashing: both classes set the `animation` shorthand, so the pulse
        // would override the flash, whose `animationend` would then never
        // fire (the highlight and its scroll-into-view would stay alive until
        // enrichment finished). A Just added card tap flashes exactly such a
        // row.
        isAiProcessing && !highlighted && 'animate-ai-processing',
        // Keyboard focus indicator (a desktop click sets it too): an inset
        // shadow, since SwipeableRow's overflow:hidden clips outlines. Drawn
        // on an overlay ABOVE the row's children (2026-10-28, Trent): on the
        // row itself the corner tabs (`RowCorner`, z-[1]) painted over it and
        // broke the ring at the top-right. Same place as before — inside the
        // border, on its inner rounding — and it never takes a pointer.
        isKeyboardFocused &&
          "after:pointer-events-none after:absolute after:inset-0 after:z-[2] after:rounded-[calc(var(--radius-lg)-1px)] after:shadow-[inset_0_0_0_2px_#3b82f6] after:content-['']",
        highlighted && 'animate-row-highlight',
      )}
    >
      {/* The corner (2026-10-14): horizon dot · attempts · priority tab —
          see `RowCorner` and `rowCorner` below. */}
      <RowCorner
        task={task}
        dot={corner.dot}
        attempts={corner.attempts}
        priority={corner.priority}
        onHorizonChange={
          onSetHorizon && !isSelectionMode ? (h) => onSetHorizon(task, h) : undefined
        }
      />
      {/* Selection checkbox (shown in selection mode) or Done button */}
      {isSelectionMode ? (
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelect?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select "${task.title}"`}
          className="h-6 w-6 flex-shrink-0"
        />
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDone()
          }}
          aria-label={
            task.rrule
              ? `Advance "${task.title}" to next occurrence`
              : `Mark "${task.title}" as done`
          }
          className={cn(
            'group/done flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            pri.check
              ? cn(pri.check.checkbox, pri.check.checkboxHover)
              : 'border-muted-foreground/30 hover:border-green-500 hover:bg-green-500/10',
          )}
          title={task.rrule ? 'Advance to next occurrence' : 'Mark as done'}
        >
          <Check
            className={cn(
              'size-4 text-transparent transition-colors',
              pri.check ? pri.check.checkIcon : 'group-hover:text-green-500',
            )}
            strokeWidth={3}
          />
        </button>
      )}

      {/* Task content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {isSelectionMode ? (
            <span className={cn('line-clamp-3 font-medium', pri.title)}>
              <ClampedTitle spacer={justAddedBadge ? null : corner.spacer} title={task.title} />
            </span>
          ) : (
            <Link
              href={`/tasks/${task.id}`}
              className={cn('line-clamp-3 font-medium hover:underline', pri.title)}
              onClick={(e) => {
                // Set keyboard focus (blue glow) before navigating
                onActivate?.()
                e.stopPropagation()
              }}
            >
              <ClampedTitle spacer={justAddedBadge ? null : corner.spacer} title={task.title} />
            </Link>
          )}
          {justAddedBadge && (
            // A box exactly one title line tall (`1lh` at the title's size),
            // with the tag centred in it — so the tag sits on
            // the title's first line whatever its size. It used to be pinned
            // to the top with a margin and sat visibly high (Trent, 09-28).
            <span
              style={corner.badgeReserve?.style}
              className={cn('flex h-[1lh] shrink-0 items-center', corner.badgeReserve?.className)}
            >
              <span
                data-just-added-badge
                className="rounded bg-indigo-50 px-1.5 py-0.5 text-center text-[11px] leading-none font-semibold whitespace-nowrap text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
              >
                <JustAddedTagText tag={justAddedBadge} />
              </span>
            </span>
          )}
        </div>

        <TaskRowMeta
          task={task}
          timezone={timezone}
          segments={metaSegments}
          timeControl={timeControl}
          offer={offer}
          onSnooze={onSnooze}
          onRemoveTarget={onRemoveTarget}
        />

        {hasIndicators && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {task.rrule && (
              <span className="text-muted-foreground inline-flex items-center" title="Recurring">
                <Repeat className="size-3" />
              </span>
            )}

            {task.auto_snooze_minutes !== null && task.auto_snooze_minutes === 0 ? (
              <span className="text-muted-foreground inline-flex items-center" title="Nag off">
                <TimerOff className="size-3" />
              </span>
            ) : task.auto_snooze_minutes !== null && task.auto_snooze_minutes > 0 ? (
              <span
                className="text-muted-foreground inline-flex items-center gap-0.5"
                title={`Nag every ${formatAutoSnoozeLabel(task.auto_snooze_minutes)}`}
              >
                <Timer className="size-3" />
                <span className="text-[11px]">
                  {formatAutoSnoozeLabel(task.auto_snooze_minutes)}
                </span>
              </span>
            ) : null}

            {task.notes && task.notes.trim() && (
              <span className="inline-flex items-center text-amber-400" title="Has notes">
                <StickyNote className="size-3" />
              </span>
            )}

            {/* The AI score (2026-10-20, Trent): a chip on this meta line, next
                to the notes mark — the label chips' shape — not a column in
                the card's right gutter. Shown only when scores are on, as
                before (the caller passes it then). */}
            {insightsScore !== undefined && (
              <Badge
                data-tour="task-score"
                data-task-score={insightsScore}
                className={cn(
                  'border-0 px-1.5 py-0 text-xs font-semibold tabular-nums',
                  getScoreColor(insightsScore),
                )}
                title={`AI attention score: ${insightsScore}/100`}
              >
                {insightsScore}
              </Badge>
            )}

            {hasLabels && (
              <LabelBadges
                labels={task.labels}
                labelConfig={labelConfig}
                onLabelClick={onLabelClick}
                onReprocess={onReprocess}
              />
            )}

            {projectName && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-[11px]',
                  projectColor ? LABEL_COLORS[projectColor].text : 'text-muted-foreground/60',
                )}
              >
                <FolderOpen className="size-2.5" />
                {projectName}
              </span>
            )}
          </div>
        )}

        {annotation && (
          <p className="mt-0.5 text-xs text-blue-600/80 dark:text-blue-300/90">
            <Sparkles className="mr-1 inline-block size-3 align-text-bottom" />
            {annotation}
          </p>
        )}

        {insightsCommentary && !annotation && (
          <p
            data-tour="task-insight"
            className="mt-0.5 text-xs text-indigo-600/80 dark:text-indigo-400/80"
          >
            <Sparkles className="mr-1 inline-block size-3 align-text-bottom" />
            {insightsCommentary}
          </p>
        )}

        {/* Insights signal pills — below commentary for visual separation from task metadata icons */}
        {insightsSignals && insightsSignals.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            {insightsSignals.map((key) => {
              const sig = SIGNAL_ICONS[key]
              if (!sig) return null
              return (
                <span
                  key={key}
                  className={cn(
                    'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    sig.bg,
                    sig.text,
                  )}
                  title={key.replace('_', ' ')}
                >
                  {sig.icon}
                  <span>{sig.label}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* The hover buttons, Today and Snooze (hidden in selection mode, and
          on a phone — swipe and the row's own gestures cover both there).
          Under a corner they sit 7px lower (`mt-3.5` on a centred item), so
          the 18px tabs never clip them on a one-line row. */}
      {!isSelectionMode && (
        <div
          className={cn(
            'shrink-0 items-center gap-1',
            dayControlsOnTouch ? 'flex' : 'hidden md:flex pointer-fine:flex',
            cornerPresent && 'mt-3.5',
          )}
        >
          {/* ON DECK (D2): Today's twin, left of it — tap decks it for
              today (or, active, takes today's deck off), hold picks the day.
              TODAY (2026-10-14): on an untargeted row, the segment rows' own
              Today (`TargetTodayButton`) — a tap targets it today, a hold or
              a right-click opens the Target menu. Mouse only, except in Now's
              On deck section (`dayControlsOnTouch`): elsewhere a finger has
              the row's swipe and editor. */}
          {showDeck && (
            <OnDeckButton
              task={task}
              timezone={timezone}
              onDeck={(t, day) => onDeck?.(t, day)}
              // Faded on a picked target, and it asks first (plan §5).
              replaces={deckReplaces(task, timezone)}
              className={dayControlClasses(
                dayControlsOnTouch,
                // A deck stays visible while it is set: the filled icon is
                // the row's only sign of it.
                !!task.on_deck_day,
              )}
              iconClassName="size-4"
            />
          )}
          {showToday && (
            <TargetTodayButton
              task={task}
              timezone={timezone}
              onTargetToday={(t) => onTargetAt?.(t)}
              onTargetAt={(t, at) => onTargetAt?.(t, at)}
              // Faded on a decked row: a target takes it off deck (plan §5).
              replaces={todayReplaces(task, timezone, dayStart)}
              className={dayControlClasses(dayControlsOnTouch, false)}
              iconClassName="size-4"
            />
          )}
          <SnoozeMenu
            open={snoozeMenuOpen}
            onOpenChange={setSnoozeMenuOpen}
            onSnooze={(until) => onSnooze(task.id, until)}
            // Remove target (`targetReset`): never on a repeating task.
            targetReset={onRemoveTarget ? targetReset(task) : null}
            onRemoveTarget={onRemoveTarget ? () => onRemoveTarget(task) : undefined}
            deadlineAt={task.deadline_at}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation()
                snoozePress.onClick()
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                snoozePress.onPointerDown(e)
              }}
              onPointerUp={(e) => {
                e.stopPropagation()
                snoozePress.onPointerUp(e)
              }}
              onPointerLeave={snoozePress.onPointerLeave}
              aria-label={`Defer "${task.title}"`}
              className="hidden flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 md:flex"
              title="Defer (hold for options)"
            >
              <Clock className="size-4" />
            </Button>
          </SnoozeMenu>
        </div>
      )}
    </div>
  )
}

/**
 * The hover On deck / Today buttons' classes: mouse-only and shown on hover
 * (or when `visible`); with `onTouch` (Now's On deck section) always shown,
 * with a finger-sized target on a coarse pointer.
 */
function dayControlClasses(onTouch: boolean, visible: boolean): string {
  if (onTouch) return 'flex size-9 pointer-coarse:size-11'
  return cn(
    'hidden size-9 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-fine:flex',
    visible ? 'opacity-100' : 'opacity-0',
  )
}

/**
 * The title inside its `line-clamp-3` box, with the corner's float spacer
 * (`rowCorner`) — in ONE block, so the clamp box has a single child.
 *
 * `line-clamp-3` is `display: -webkit-box`, which WebKit (Safari, the iOS app's
 * web view) lays out as a legacy flexbox: each direct child is a box item of
 * its own, stacked vertically, and `float` does nothing to one. The spacer
 * used to be a direct child, so in WebKit it took a row of its own ABOVE the
 * text instead of floating beside it — a blank band as tall as the spacer
 * (31px under the horizon dot on a phone; 4px under a priority tab alone)
 * over the title of every corner row (Trent's iPhone, 2026-10-26). Chromium
 * floats it either way. Inside this block the float is an ordinary float in
 * both engines, and the clamp still counts the block's lines (ellipsis
 * included).
 */
function ClampedTitle({ spacer, title }: { spacer: React.ReactNode; title: string }) {
  return (
    <span className="block">
      {spacer}
      {title}
    </span>
  )
}

/**
 * The just-now tag's words. A deck for a later day (2026-10-22: "On deck
 * tomorrow", "On deck Oct 27", `deckTagLabel`) is twice as wide as the other
 * tags, and on a phone, beside the corner's reserve, it squeezed the title
 * until words were cut mid-letter. So below `sm` it stacks on two lines —
 * "On deck" over the day — which at 11px still fits inside the title's first
 * line (`h-[1lh]`), so the row keeps its height. One line from `sm` up.
 */
function JustAddedTagText({ tag }: { tag: string }) {
  const day = tag.startsWith('On deck ') ? tag.slice('On deck '.length) : null
  if (!day) return <>{tag}</>
  return (
    <>
      On deck
      <br className="sm:hidden" /> {day}
    </>
  )
}

/**
 * The row's second line: the target time — a control (`TargetTimeText`:
 * Remove target / Move…, and the hover ×) wherever the row can act on it —
 * then the rest of the meta segments (the recurrence, the deadline, the age),
 * and the attempts offer at 3× ("Remove target?").
 */
function TaskRowMeta({
  task,
  timezone,
  segments,
  timeControl,
  offer,
  onSnooze,
  onRemoveTarget,
}: {
  task: Task
  timezone: string
  segments: MetaSegment[]
  timeControl: boolean
  offer: 'remove' | null
  onSnooze: (taskId: number, until: string) => void
  onRemoveTarget?: (task: Task) => void
}) {
  // The deadline chip leads the line (2026-10-22, `DeadlineChip`) — not on a
  // quota, which carries no deadline.
  const deadline = task.deadline_at && !isTracked(task) ? task.deadline_at : null
  if (segments.length === 0 && !offer && !deadline) return null
  // The target time is a chip (`TimeChip`, 2026-10-28): a control when the
  // row allows it, the same chip as a label otherwise (selection mode).
  const targetParts = segments.filter((seg) => seg.target)
  const over = targetParts.some((seg) => seg.over)
  const rest = segments.filter((seg) => !seg.target)
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-sm">
      {deadline && (
        <DeadlineChip deadlineAt={deadline} timezone={timezone} className="mr-0.5 text-xs" />
      )}
      {targetParts.length > 0 &&
        (timeControl ? (
          <TargetTimeText
            task={task}
            timezone={timezone}
            text={targetChipText(targetParts)}
            over={over}
            onMove={(until) => onSnooze(task.id, until)}
            onRemoveTarget={onRemoveTarget}
          />
        ) : (
          <TimeChip tone={over ? 'over' : 'target'} className="text-xs" data-target-time-label="">
            {targetChipText(targetParts)}
          </TimeChip>
        ))}
      {rest.map((seg, i) => (
        <span key={i} className="contents">
          {(i > 0 || targetParts.length > 0) && <span className="text-muted-foreground/50">·</span>}
          <span
            className={cn('whitespace-nowrap', seg.className)}
            data-age-label={seg.ageLabel ? seg.text : undefined}
          >
            {seg.text}
          </span>
        </span>
      ))}
      {offer && (
        <button
          type="button"
          data-attempts-offer={offer}
          // The click must not reach the row (select / open). Not the
          // pointerdown, like the done button: SwipeableRow's drag
          // handler swallows a click whose pointerdown it never saw.
          onClick={(e) => {
            e.stopPropagation()
            onRemoveTarget?.(task)
          }}
          className="text-over-target hover:bg-over-target/10 -my-0.5 rounded px-1 py-0.5 text-xs font-medium whitespace-nowrap underline-offset-2 hover:underline"
        >
          {REMOVE_TARGET}?
        </button>
      )}
    </div>
  )
}

/** A target chip's words: "Tomorrow 7:00 AM", "3h ago · 5:00 PM", "Yesterday · 10:00 AM". */
function targetChipText(parts: MetaSegment[]): string {
  const text = parts.map((p) => p.text).join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface MetaSegment {
  text: string
  className?: string
  /** The age badge (`data-age-label`). */
  ageLabel?: boolean
  /** Part of the target time ("3h ago", "9:00 AM") — `TargetTimeText`. */
  target?: boolean
  /** The target has passed: its chip is plum (`TimeChip`). */
  over?: boolean
}

/** "2 / 4 this week" — a quota's standing, as its row's only metadata. */
function trackedMetaSegments(task: Task): MetaSegment[] {
  const { current, target, met } = trackState(task)
  const period = taskPeriodLabel(task)
  return [
    {
      text: `${current} / ${target}${period ? ` ${period}` : ''}${met ? ' · met' : ''}`,
      className: met ? 'text-green-700 dark:text-green-400' : undefined,
    },
  ]
}

function buildMetaSegments(
  task: Task,
  timezone: string,
  dayStart: string,
  isOverdue?: boolean,
  queuedOccurrence?: string | null,
): MetaSegment[] {
  const segments: MetaSegment[] = []

  // No "snoozed" colour or "snoozed from" note since 2026-10-12 (§6): there is
  // no snooze state — a snooze is a move of the target, nothing more.
  if (queuedOccurrence) {
    // A waiting repeating task: the occurrence's date, plain text (not the
    // target control — the moved target is not what the row stands for).
    segments.push({
      text: DateTime.fromISO(queuedOccurrence).setZone(timezone).toFormat('ccc, LLL d, h:mm a'),
    })
  } else if (task.due_at) {
    const dueParts = formatDueTimeParts(task.due_at, timezone, dayStart)
    segments.push({ text: dueParts.relative, target: true, over: isOverdue })
    if (dueParts.absolute) segments.push({ text: dueParts.absolute, target: true, over: isOverdue })
  }

  if (task.rrule) {
    segments.push({ text: formatRRuleCompact(task.rrule, task.anchor_time) })
  }

  // The deadline (2026-10-10) is not a segment since 2026-10-22: it leads the
  // line as the deadline chip (`DeadlineChip`, in `TaskRowMeta`) — red once
  // passed (nagging continues; Trent: "sometimes it's for a client and you're
  // in a rush"), amber in the safety net.

  // AGE (spec §7, 2026-10-12; replaced the "Xd old" text every row had): only
  // on a task with neither a target nor a deadline, and only once it is past
  // its horizon's threshold — ">1 wk" (days), ">1 mo" (weeks or unset),
  // ">3 mo" (months), ">6 mo" (eventually). A dated task's slipping is told by
  // its attempts tab instead.
  const age = ageLabel(task, new Date(), timezone)
  if (age) segments.push({ text: age, className: 'text-muted-foreground/70', ageLabel: true })

  return segments
}

/**
 * What the row's corner shows (2026-10-14, `src/lib/row-corner.ts`), plus the
 * title's FLOAT SPACER: an invisible `float: right` box at the start of the
 * title, so a long title wraps around the corner tabs instead of running
 * under them. It is as wide as the part of the corner that reaches over the
 * title's column — the tabs' estimated width (`cornerWidth`), plus the dot's
 * enlarged hit box to its left, less what already sits to the right of the
 * title (the row's 12px padding; from `md` up, the snooze button and its gap
 * too) — and as tall as the tabs, or the dot's hit box (32px with a mouse,
 * 44px with a finger, measured from the row's top border), but NEVER TALLER
 * THAN ONE TITLE LINE (`min(…, 1lh)`, 2026-10-26).
 *
 * Why the cap: the title's clamp box contains its floats, so a spacer taller
 * than the title's first line made the box taller than the title. A one-line
 * title then sat above the done circle's centre (3.5px at the default size on
 * a phone: a 31px spacer beside a 24px line) and the meta line below it
 * dropped by the difference — every dot row's title sat higher than a row
 * without a tab. Capped, the title lands where it would with no corner at
 * all. What it gives up, on touch only: when a title wraps, the end of its
 * SECOND line can run under the bottom few px of the dot's 44px hit box
 * (31px − 1lh: 7px at the default size, ~2.4px at the iOS app's 119%, none
 * with a mouse), where a tap opens the horizon menu. The tabs themselves
 * (18px, 4px into the content) are always inside the first line.
 *
 * The spacer sits inside `ClampedTitle`'s block, not directly in the clamp
 * box — see there for the WebKit band that placement prevents.
 *
 * A "New" / "Targeted" tag (`justAddedBadge`) sits after the title in the
 * title's flex row, so it is the one beside the corner: then the spacer is left
 * out and the tag keeps the same distance as a right margin (`badgeReserve`) —
 * every title line gives up that width for the tag's 15 minutes.
 *
 * Priority Display preferences (Settings), now that the tab shows priority:
 * - `trailingDot` ("Show priority indicator") turns the corner tab on or
 *   off — it was the indicators line's word or icon, which the tab replaces.
 * - `badgeStyle` ("Words" / "Icons") is what the tab says: "High", or "!".
 * - Low priority no longer shows anything there (Trent's E2b pick: Low and
 *   None get no tab). `colorTitle`, `rightBorder` and `colorCheckbox` are
 *   unchanged, Low included.
 */
function rowCorner({
  task,
  attempts,
  priorityTab,
  isSelectionMode,
}: {
  task: Task
  attempts: number
  /** `priorityRowStyles(...).tab`: null when the indicator is off or below High. */
  priorityTab: PriorityTab | null
  isSelectionMode: boolean
}): {
  dot: boolean
  attempts: number
  priority: PriorityTab | null
  spacer: React.ReactNode
  badgeReserve: { style: React.CSSProperties; className: string } | null
} {
  const dot = showsHorizonDot(task)
  const priority = priorityTab
  const width = cornerWidth({ dot, attempts, priorityText: priority?.text ?? null })
  if (width === 0) return { dot, attempts, priority, spacer: null, badgeReserve: null }
  const insetNarrow = 12
  const insetWide = isSelectionMode ? 12 : 12 + 12 + 36
  const reach = (inset: number, ext: number) => `${Math.max(0, width + (dot ? ext : 0) - inset)}px`
  const style = {
    '--sw-f': reach(insetNarrow, 8),
    '--sw-c': reach(insetNarrow, 20),
    '--sw-mf': reach(insetWide, 8),
    '--sw-mc': reach(insetWide, 20),
  } as React.CSSProperties
  const spacer = (
    <span
      aria-hidden
      data-corner-spacer
      style={style}
      className={cn(
        'float-right w-(--sw-f) md:w-(--sw-mf) pointer-coarse:w-(--sw-c) md:pointer-coarse:w-(--sw-mc)',
        // Content starts 13px below the row's outer top (1px border + 12px
        // padding): the tabs end 4px in, the dot's hit box 18px / 30px in —
        // capped at one title line (`1lh`, the title's own line height; see
        // above).
        dot ? 'h-[min(19px,1lh)] pointer-coarse:h-[min(31px,1lh)]' : 'h-1',
      )}
    />
  )
  const badgeReserve = {
    style,
    className:
      'mr-(--sw-f) md:mr-(--sw-mf) pointer-coarse:mr-(--sw-c) md:pointer-coarse:mr-(--sw-mc)',
  }
  return { dot, attempts, priority, spacer, badgeReserve }
}
