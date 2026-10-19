'use client'

import { useRef, useCallback, useEffect, useState } from 'react'
import { useLongPress, useSimpleLongPress } from '@/hooks/useLongPress'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  Clock,
  Eye,
  FolderOpen,
  HelpCircle,
  RefreshCw,
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
  queueRetiredOffer,
  effectiveAttempts,
  isPastDeadline,
  targetReset,
  type HorizonValue,
} from '@/lib/task-segments'
import { BACK_TO_AUTO } from '@/lib/task-model-words'
import { cornerWidth, offersTargetToday, priorityTab, showsHorizonDot } from '@/lib/row-corner'
import { RowCorner } from '@/components/RowCorner'
import { TargetTodayButton } from '@/components/TargetMenu'
import { TargetTimeText } from '@/components/TargetTimeText'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { useTimezone } from '@/hooks/useTimezone'
import {
  useLabelConfig,
  usePriorityDisplay,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { getLabelClasses, LABEL_COLORS } from '@/lib/label-colors'
import { computeSnoozeTime } from '@/lib/snooze'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import type { Task, LabelConfig, LabelColor, PriorityDisplayConfig } from '@/types'

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
  const { labelConfig } = useLabelConfig()
  const { priorityDisplay } = usePriorityDisplay()
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
    if (!isOverdue) {
      setSnoozeMenuOpen(true)
      return
    }
    onSnooze(task.id, computeSnoozeTime(defaultSnoozeOption, timezone, morningTime, timeSlots))
  }, [task.id, defaultSnoozeOption, timezone, morningTime, timeSlots, onSnooze, isOverdue])
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

  const priorityColors = getPriorityColors(task.priority)
  const isAiProcessing = task.labels.includes('ai-to-process')
  const tracked = isTracked(task)
  const pastDeadline = !tracked && isPastDeadline(task.deadline_at, new Date())
  // §5: a quota's row states its count where a task states its due time; the
  // controls live in the Track panel on the Tasks page, not on every row.
  const metaSegments = tracked
    ? trackedMetaSegments(task)
    : buildMetaSegments(task, timezone, isOverdue)
  // ATTEMPTS (spec §7): local days over target, read here with the same rule
  // the server uses, so the row shows "1×" the moment the target passes
  // without a refetch. At 3× the row OFFERS to drop the target (never does it
  // on its own): "Remove target?", or "Back to auto?" on a deadline task whose
  // target the user picked; nothing on an automatic target or a repeating task.
  //
  // The task queue (resolution 1) retires "Remove target?" on a strippable
  // one-off — but only with the SERVER's switch on, which the browser can't
  // read yet (PR 3 gives it the switch). Until then the offer is read live, as
  // always, and the server's `attempts_offer` only SUPPRESSES: when the server
  // already counted 3× (`task.attempts`) on a strippable task and still sent
  // null, it retired the offer. With the switch off the server sends "remove"
  // there, so the row behaves exactly as before.
  const attempts = effectiveAttempts(task, timezone, new Date()).attempts
  const liveOffer =
    onRemoveTarget && !isSelectionMode && !tracked ? attemptsOffer({ ...task, attempts }) : null
  const offer = queueRetiredOffer(task, liveOffer) ? null : liveOffer
  const corner = rowCorner({
    task,
    attempts: !tracked && task.due_at !== null ? attempts : 0,
    priorityDisplay,
    isSelectionMode,
  })
  // The target time is a control (Remove target / Move…, `TargetTimeText`)
  // wherever the row can act on it: not in selection mode, where a press on
  // the row selects.
  const timeControl = !isSelectionMode && !tracked && task.due_at !== null
  const showToday = !isSelectionMode && !!onTargetAt && offersTargetToday(task)
  const cornerPresent = corner.dot || corner.attempts >= 1 || corner.priority !== null
  // Filter ai-to-process from visible label count (animation conveys that state)
  const visibleLabelCount = task.labels.filter((l) => l !== 'ai-to-process').length
  const hasLabels = visibleLabelCount > 0
  const hasIndicators =
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
        priorityDisplay.rightBorder && priorityColors && 'border-r-4 pr-[9px]',
        priorityDisplay.rightBorder && priorityColors?.border,
        isSelected && 'ring-ring bg-accent ring-2',
        isSelectionMode && 'cursor-pointer',
        // AI enrichment in progress — subtle border pulse. Not while the row is
        // flashing: both classes set the `animation` shorthand, so the pulse
        // would override the flash, whose `animationend` would then never
        // fire (the highlight and its scroll-into-view would stay alive until
        // enrichment finished). A Just added card tap flashes exactly such a
        // row.
        isAiProcessing && !highlighted && 'animate-ai-processing',
        // Keyboard focus indicator - uses inset shadow since SwipeableRow's overflow:hidden clips outlines
        isKeyboardFocused && 'shadow-[inset_0_0_0_2px_#3b82f6]',
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
            priorityDisplay.colorCheckbox && priorityColors
              ? cn(priorityColors.checkbox, priorityColors.checkboxHover)
              : 'border-muted-foreground/30 hover:border-green-500 hover:bg-green-500/10',
          )}
          title={task.rrule ? 'Advance to next occurrence' : 'Mark as done'}
        >
          <Check
            className={cn(
              'size-4 text-transparent transition-colors',
              priorityDisplay.colorCheckbox && priorityColors
                ? priorityColors.checkIcon
                : 'group-hover:text-green-500',
            )}
            strokeWidth={3}
          />
        </button>
      )}

      {/* Task content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {isSelectionMode ? (
            <span
              className={cn(
                'line-clamp-3 font-medium',
                priorityDisplay.colorTitle && priorityColors?.text,
              )}
            >
              {!justAddedBadge && corner.spacer}
              {task.title}
            </span>
          ) : (
            <Link
              href={`/tasks/${task.id}`}
              className={cn(
                'line-clamp-3 font-medium hover:underline',
                priorityDisplay.colorTitle && priorityColors?.text,
              )}
              onClick={(e) => {
                // Set keyboard focus (blue glow) before navigating
                onActivate?.()
                e.stopPropagation()
              }}
            >
              {!justAddedBadge && corner.spacer}
              {task.title}
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
                className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] leading-none font-semibold whitespace-nowrap text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
              >
                {justAddedBadge}
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
              <span
                className="text-muted-foreground inline-flex items-center"
                title="Auto-snooze off"
              >
                <TimerOff className="size-3" />
              </span>
            ) : task.auto_snooze_minutes !== null && task.auto_snooze_minutes > 0 ? (
              <span
                className="text-muted-foreground inline-flex items-center gap-0.5"
                title={`Auto-snooze: ${formatAutoSnoozeLabel(task.auto_snooze_minutes)}`}
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

      {/* Insights score badge */}
      {insightsScore !== undefined && (
        <span
          data-tour="task-score"
          className={cn(
            'flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
            getScoreColor(insightsScore),
          )}
          title={`AI attention score: ${insightsScore}/100`}
        >
          {insightsScore}
        </span>
      )}

      {/* The hover buttons, Today and Snooze (hidden in selection mode, and
          on a phone — swipe and the row's own gestures cover both there).
          Under a corner they sit 7px lower (`mt-3.5` on a centred item), so
          the 18px tabs never clip them on a one-line row. */}
      {!isSelectionMode && (
        <div
          className={cn(
            'hidden shrink-0 items-center gap-1 md:flex pointer-fine:flex',
            cornerPresent && 'mt-3.5',
          )}
        >
          {/* TODAY (2026-10-14): on an untargeted row, the segment rows' own
              Today (`TargetTodayButton`) — a tap targets it today, a hold or
              a right-click opens the Target menu. Mouse only: a finger has
              the row's swipe and editor. */}
          {showToday && (
            <TargetTodayButton
              task={task}
              timezone={timezone}
              onTargetToday={(t) => onTargetAt?.(t)}
              onTargetAt={(t, at) => onTargetAt?.(t, at)}
              className="hidden size-9 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-fine:flex"
              iconClassName="size-4"
            />
          )}
          <SnoozeMenu
            open={snoozeMenuOpen}
            onOpenChange={setSnoozeMenuOpen}
            onSnooze={(until) => onSnooze(task.id, until)}
            // Remove target, or "Back to auto" on a deadline task whose target
            // the user picked; nothing on an automatic target (§8.3, Q9).
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
              aria-label={`Snooze "${task.title}"`}
              className="hidden flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 md:flex"
              title="Snooze (hold for options)"
            >
              <Clock className="size-4" />
            </Button>
          </SnoozeMenu>
        </div>
      )}
    </div>
  )
}

function LabelBadges({
  labels,
  labelConfig,
  onLabelClick,
  onReprocess,
}: {
  labels: string[]
  labelConfig: LabelConfig[]
  onLabelClick?: (label: string) => void
  onReprocess?: () => void
}) {
  // Filter out ai-to-process (the animation conveys that state)
  const visibleLabels = labels.filter((l) => l !== 'ai-to-process')

  return (
    <div className="flex flex-shrink-0 items-center gap-1">
      {visibleLabels.slice(0, 2).map((label) => {
        const colorClasses = getLabelClasses(label, labelConfig)
        const isAiFailed = label === 'ai-failed'
        return (
          <span
            key={label}
            className={cn(
              'inline-flex items-center gap-0.5',
              isAiFailed && onReprocess && 'group/retry',
            )}
          >
            <Badge
              variant={colorClasses ? undefined : 'secondary'}
              className={cn(
                'px-1.5 py-0 text-xs',
                colorClasses && `${colorClasses} border-0`,
                onLabelClick && 'cursor-pointer',
              )}
              onClick={(e) => {
                e.stopPropagation()
                onLabelClick?.(label)
              }}
            >
              {label}
            </Badge>
            {isAiFailed && onReprocess && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onReprocess()
                }}
                className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center rounded p-0.5 transition-colors"
                title="Retry AI enrichment"
                aria-label="Retry AI enrichment"
              >
                <RefreshCw className="size-3" />
              </button>
            )}
          </span>
        )
      })}
      {visibleLabels.length > 2 && (
        <span className="text-muted-foreground text-xs">+{visibleLabels.length - 2}</span>
      )}
    </div>
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
  offer: 'auto' | 'remove' | null
  onSnooze: (taskId: number, until: string) => void
  onRemoveTarget?: (task: Task) => void
}) {
  if (segments.length === 0 && !offer) return null
  // The segments after the target time, or all of them when it is plain text.
  const rest = timeControl ? segments.filter((seg) => !seg.target) : segments
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-sm">
      {timeControl && (
        <TargetTimeText
          task={task}
          timezone={timezone}
          relative={segments[0].text}
          absolute={segments[1]?.target ? segments[1].text : null}
          relativeClassName={segments[0].className}
          onMove={(until) => onSnooze(task.id, until)}
          onRemoveTarget={onRemoveTarget}
        />
      )}
      {rest.map((seg, i) => (
        <span key={i} className="contents">
          {(i > 0 || timeControl) && <span className="text-muted-foreground/50">·</span>}
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
          {offer === 'auto' ? `${BACK_TO_AUTO}?` : 'Remove target?'}
        </button>
      )}
    </div>
  )
}

interface MetaSegment {
  text: string
  className?: string
  /** The age badge (`data-age-label`). */
  ageLabel?: boolean
  /** Part of the target time ("3h ago", "9:00 AM") — `TargetTimeText`. */
  target?: boolean
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

function buildMetaSegments(task: Task, timezone: string, isOverdue?: boolean): MetaSegment[] {
  const segments: MetaSegment[] = []

  // No "snoozed" colour or "snoozed from" note since 2026-10-12 (§6): there is
  // no snooze state — a snooze is a move of the target, nothing more.
  if (task.due_at) {
    const dueParts = formatDueTimeParts(task.due_at, timezone)
    segments.push({
      text: dueParts.relative,
      className: isOverdue ? 'text-over-target font-medium' : undefined,
      target: true,
    })
    if (dueParts.absolute) segments.push({ text: dueParts.absolute, target: true })
  }

  if (task.rrule) {
    segments.push({ text: formatRRuleCompact(task.rrule, task.anchor_time) })
  }

  // The deadline (2026-10-10): its own field now, never moved by a snooze.
  // Past it, the row says so — nagging continues (Trent: "sometimes it's for a
  // client and you're in a rush"), and this marker is the honest label.
  const deadline = deadlineSegment(task, timezone)
  if (deadline) segments.push(deadline)

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
 * The deadline (2026-10-10): its own field now, never moved by a snooze.
 * Past it, the row says so — nagging continues (Trent: "sometimes it's for a
 * client and you're in a rush"), and this marker is the honest label.
 */
function deadlineSegment(task: Task, timezone: string): MetaSegment | null {
  if (!task.deadline_at) return null
  const when = formatDueTimeParts(task.deadline_at, timezone)
  if (isPastDeadline(task.deadline_at, new Date())) {
    return {
      text: `past deadline ${when.absolute || when.relative}`,
      className: 'text-destructive font-semibold',
    }
  }
  return {
    text: `deadline ${when.relative}`,
    className: 'text-amber-700 dark:text-amber-400 font-medium',
  }
}

/**
 * Priority color classes for different UI elements
 */
function getPriorityColors(priority: number): {
  text: string
  border: string
  /** Muted border color for the done-button circle */
  checkbox: string
  /** Hover styles for the done-button (border + background tint) */
  checkboxHover: string
  /** Checkmark color on hover — matches priority instead of green */
  checkIcon: string
} | null {
  switch (priority) {
    case 1:
      return {
        text: 'text-zinc-400',
        border: 'border-r-zinc-400/50',
        checkbox: 'border-zinc-400/60',
        checkboxHover: 'hover:border-zinc-400 hover:bg-zinc-400/10',
        checkIcon: 'group-hover/done:text-zinc-400',
      }
    case 2:
      return {
        text: 'text-amber-500',
        border: 'border-r-amber-500/50',
        checkbox: 'border-amber-400/50',
        checkboxHover: 'hover:border-amber-500/70 hover:bg-amber-400/10',
        checkIcon: 'group-hover/done:text-amber-500',
      }
    case 3:
      return {
        text: 'text-orange-500',
        border: 'border-r-orange-500/50',
        checkbox: 'border-orange-400/50',
        checkboxHover: 'hover:border-orange-500/70 hover:bg-orange-400/10',
        checkIcon: 'group-hover/done:text-orange-500',
      }
    case 4:
      return {
        text: 'text-red-500',
        border: 'border-r-red-500/50',
        checkbox: 'border-red-400/50',
        checkboxHover: 'hover:border-red-500/70 hover:bg-red-400/10',
        checkIcon: 'group-hover/done:text-red-500',
      }
    default:
      return null
  }
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
 * 44px with a finger, measured from the row's top border).
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
  priorityDisplay,
  isSelectionMode,
}: {
  task: Task
  attempts: number
  priorityDisplay: PriorityDisplayConfig
  isSelectionMode: boolean
}): {
  dot: boolean
  attempts: number
  priority: ReturnType<typeof priorityTab>
  spacer: React.ReactNode
  badgeReserve: { style: React.CSSProperties; className: string } | null
} {
  const dot = showsHorizonDot(task)
  const priority = priorityDisplay.trailingDot
    ? priorityTab(task.priority, priorityDisplay.badgeStyle)
    : null
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
        // padding): the tabs end 4px in, the dot's hit box 18px / 30px in.
        dot ? 'h-[19px] pointer-coarse:h-[31px]' : 'h-1',
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
