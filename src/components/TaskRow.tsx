'use client'

import { useRef, useCallback, useEffect, useState } from 'react'
import { useLongPress } from '@/hooks/useLongPress'
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
import { formatDueTimeParts, formatOriginalDueAt, formatTaskAge } from '@/lib/format-date'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { useTimezone } from '@/hooks/useTimezone'
import {
  useLabelConfig,
  usePriorityDisplay,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { getLabelClasses, LABEL_COLORS } from '@/lib/label-colors'
import { computeSnoozeTime } from '@/lib/snooze'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import type { Task, LabelConfig, LabelColor } from '@/types'

/**
 * TaskRow visual reference — complete rendered examples:
 *
 *   Line 1: [title]
 *   Line 2: [relative time] · [absolute time] · [recurrence text] · [snoozed from X]
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
 * Snoozed (blue left border, snoozed-from context):
 *   ┃─────────────────────────────────────────────────────────┐
 *   ┃ ○  Review PR  [ops]                                     │
 *   ┃    Tomorrow 3:00 PM · snoozed from Tue                  │
 *   ┃─────────────────────────────────────────────────────────┘
 *
 * Overdue times: <1m ago · 5:00 PM | 3h ago · 9 AM | yesterday · 5 PM | 3d ago · Jan 30 5 PM
 * Future times:  in 47m · 5:00 PM · Tomorrow 9 AM · Wed 9 AM · Feb 11 9 AM
 * Left border:   red=overdue (wins), blue=snoozed, none=default
 * Snooze button:  desktop only (hover) — mobile uses swipe
 */

interface TaskRowProps {
  task: Task
  onDone: () => void
  /** Called with (taskId, until) for immediate snooze */
  onSnooze: (taskId: number, until: string) => void
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

/** Color class for insights score badge */
function getScoreColor(score: number): string {
  if (score >= 70) return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  if (score >= 40) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
}

export function TaskRow({
  task,
  onDone,
  onSnooze,
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
}: TaskRowProps) {
  const timezone = useTimezone()
  const { labelConfig } = useLabelConfig()
  const { priorityDisplay } = usePriorityDisplay()
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)

  // Long-press state for snooze button
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snoozeFiredRef = useRef(false)

  // Snooze button uses pointer events for single-click / long-press detection.
  // Primary trigger is onPointerUp (not onClick) because stopPropagation() on
  // onPointerDown can prevent click events from being synthesized in some browsers.
  // onClick is kept as a fallback for keyboard activation (Enter/Space).
  const handleSnoozeClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // If long-press fired or pointer already handled the snooze, suppress
      if (snoozeFiredRef.current) {
        snoozeFiredRef.current = false
        return
      }
      // Non-overdue tasks: open snooze menu instead of instant snooze
      // (instant snooze would rewind a future due date to now + offset)
      if (!isOverdue) {
        snoozeFiredRef.current = true
        setSnoozeMenuOpen(true)
        return
      }
      // Fallback for keyboard activation (Enter/Space) — pointer path won't set snoozeFiredRef
      const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
      onSnooze(task.id, until)
    },
    [task.id, defaultSnoozeOption, timezone, morningTime, onSnooze, isOverdue],
  )

  const handleSnoozePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    snoozeFiredRef.current = false
    snoozeTimerRef.current = setTimeout(() => {
      snoozeFiredRef.current = true
      setSnoozeMenuOpen(true)
    }, 400)
  }, [])

  const handleSnoozePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation()
      if (snoozeTimerRef.current) {
        clearTimeout(snoozeTimerRef.current)
        snoozeTimerRef.current = null
      }
      // Quick tap: timer was running but long-press didn't fire
      if (!snoozeFiredRef.current) {
        snoozeFiredRef.current = true // suppress any subsequent click
        // Non-overdue tasks: open snooze menu instead of instant snooze
        if (!isOverdue) {
          setSnoozeMenuOpen(true)
          return
        }
        const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
        onSnooze(task.id, until)
      }
    },
    [task.id, defaultSnoozeOption, timezone, morningTime, onSnooze, isOverdue],
  )

  const handleSnoozePointerLeave = useCallback(() => {
    if (snoozeTimerRef.current) {
      clearTimeout(snoozeTimerRef.current)
      snoozeTimerRef.current = null
    }
  }, [])

  // Clean up snooze timer on unmount
  useEffect(() => {
    return () => {
      if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current)
    }
  }, [])
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

  const priorityBadge = getPriorityBadge(task.priority)
  const priorityIcon = getPriorityIcon(task.priority)
  const priorityColors = getPriorityColors(task.priority)
  // A task is snoozed when its due date has drifted from the original.
  // On creation, original_due_at === due_at; snoozing changes due_at but not original_due_at.
  const isSnoozed = task.original_due_at !== null && task.original_due_at !== task.due_at
  const isAiProcessing = task.labels.includes('ai-to-process')
  const metaSegments = buildMetaSegments(task, timezone, isOverdue)
  // Filter ai-to-process from visible label count (animation conveys that state)
  const visibleLabelCount = task.labels.filter((l) => l !== 'ai-to-process').length
  const hasLabels = visibleLabelCount > 0
  const hasPriorityIndicator = priorityDisplay.trailingDot && (priorityBadge || priorityIcon)
  const hasIndicators =
    !!hasPriorityIndicator ||
    !!task.rrule ||
    task.auto_snooze_minutes !== null ||
    !!(task.notes && task.notes.trim()) ||
    hasLabels ||
    !!projectName

  return (
    <div
      id={`task-row-${task.id}`}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      onClick={handleClick}
      onMouseEnter={onFocus}
      onMouseDown={(e) => e.stopPropagation()} // Prevent triggering list's onMouseInteraction
      onPointerDown={pointer.onPointerDown}
      onPointerUp={pointer.onPointerUp}
      onPointerMove={pointer.onPointerMove}
      onPointerLeave={pointer.onPointerLeave}
      onPointerCancel={pointer.onPointerUp}
      className={cn(
        'group flex items-center gap-3 rounded-lg p-3 select-none',
        // min-h-[62px] matches the natural height when snooze button is present:
        // snooze button (36px h-9) + padding (24px) + border (2px) = 62px
        // This prevents single-line tasks from shrinking when entering selection mode.
        'bg-card min-h-[62px] border',
        'hover:border-border/80 transition-colors',
        isAiHighlighted && !isSelected && 'bg-blue-50/50 dark:bg-blue-950/20',
        isOverdue && 'border-l-destructive border-l-4',
        !isOverdue && isSnoozed && 'border-l-4 border-l-blue-400',
        // Right border for priority (user preference)
        priorityDisplay.rightBorder && priorityColors && 'border-r-4',
        priorityDisplay.rightBorder && priorityColors?.border,
        isSelected && 'ring-ring bg-accent ring-2',
        isSelectionMode && 'cursor-pointer',
        // AI enrichment in progress — subtle border pulse
        isAiProcessing && 'animate-ai-processing',
        // Keyboard focus indicator - uses inset shadow since SwipeableRow's overflow:hidden clips outlines
        isKeyboardFocused && 'shadow-[inset_0_0_0_2px_#3b82f6]',
      )}
    >
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
                getTitleSizeClass(task.title),
                priorityDisplay.colorTitle && priorityColors?.text,
              )}
            >
              {task.title}
            </span>
          ) : (
            <Link
              href={`/tasks/${task.id}`}
              className={cn(
                'line-clamp-3 font-medium hover:underline',
                getTitleSizeClass(task.title),
                priorityDisplay.colorTitle && priorityColors?.text,
              )}
              onClick={(e) => {
                // Set keyboard focus (blue glow) before navigating
                onActivate?.()
                e.stopPropagation()
              }}
            >
              {task.title}
            </Link>
          )}
        </div>

        {metaSegments.length > 0 && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-sm">
            {metaSegments.map((seg, i) => (
              <span key={i} className="contents">
                <span className={cn('whitespace-nowrap', seg.className)}>{seg.text}</span>
                {i < metaSegments.length - 1 && <span className="text-muted-foreground/50">·</span>}
              </span>
            ))}
          </div>
        )}

        {hasIndicators && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {priorityDisplay.trailingDot &&
              (priorityDisplay.badgeStyle === 'icons' && priorityIcon ? (
                <span
                  className={cn(priorityIcon.className, priorityIcon.color)}
                  title={priorityIcon.title}
                >
                  {priorityIcon.icon}
                </span>
              ) : (
                priorityBadge && (
                  <span
                    className={cn(
                      'rounded px-1 py-0.5 text-[10px] leading-none font-semibold',
                      priorityBadge.bg,
                      priorityBadge.text,
                    )}
                    title={priorityBadge.title}
                  >
                    {priorityBadge.label}
                  </span>
                )
              ))}

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
          <p className="mt-0.5 text-xs text-indigo-600/80 dark:text-indigo-400/80">
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
          className={cn(
            'flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
            getScoreColor(insightsScore),
          )}
          title={`AI attention score: ${insightsScore}/100`}
        >
          {insightsScore}
        </span>
      )}

      {/* Snooze button (hidden in selection mode and on mobile — swipe-to-snooze is the mobile interaction).
          Single click: immediate snooze with default duration.
          Long-press (400ms): opens SnoozeMenu with duration choices. */}
      {!isSelectionMode && (
        <SnoozeMenu
          open={snoozeMenuOpen}
          onOpenChange={setSnoozeMenuOpen}
          onSnooze={(until) => onSnooze(task.id, until)}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSnoozeClick}
            onPointerDown={handleSnoozePointerDown}
            onPointerUp={handleSnoozePointerUp}
            onPointerLeave={handleSnoozePointerLeave}
            aria-label={`Snooze "${task.title}"`}
            className="hidden flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 md:flex"
            title="Snooze (hold for options)"
          >
            <Clock className="size-4" />
          </Button>
        </SnoozeMenu>
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

interface MetaSegment {
  text: string
  className?: string
}

function buildMetaSegments(task: Task, timezone: string, isOverdue?: boolean): MetaSegment[] {
  const segments: MetaSegment[] = []

  const isSnoozed = task.original_due_at !== null && task.original_due_at !== task.due_at

  if (task.due_at) {
    const dueParts = formatDueTimeParts(task.due_at, timezone)
    // Snoozed tasks show the new due time in blue (overdue red wins)
    const snoozedClass = isSnoozed ? 'text-blue-400' : undefined
    segments.push({
      text: dueParts.relative,
      className: isOverdue ? 'text-destructive font-medium' : snoozedClass,
    })
    if (dueParts.absolute) {
      segments.push({ text: dueParts.absolute, className: isOverdue ? undefined : snoozedClass })
    }
  }

  if (task.rrule) {
    segments.push({ text: formatRRuleCompact(task.rrule, task.anchor_time) })
  }

  // Show "snoozed from" when the due date has drifted from the original
  if (isSnoozed && task.original_due_at) {
    const text = formatOriginalDueAt(task.original_due_at, timezone)
    if (text) {
      segments.push({ text, className: 'text-muted-foreground/60' })
    }
  }

  // Age indicator: how old a task is (very subtle, at the end of metadata)
  // One-off: original_due_at ?? created_at (captures deferral time when present)
  // Recurring: original_due_at ?? due_at (when the current occurrence was originally due)
  const ageAnchor = task.rrule
    ? (task.original_due_at ?? task.due_at)
    : (task.original_due_at ?? task.created_at)
  if (ageAnchor) {
    const ageText = formatTaskAge(ageAnchor, timezone)
    if (ageText) segments.push({ text: ageText, className: 'text-muted-foreground/50' })
  }

  return segments
}

/**
 * Tiered text sizing for task titles on the dashboard.
 * Short titles use the default size, medium titles shrink to text-sm,
 * and long titles shrink to text-xs to fit more content in 3 lines.
 */
function getTitleSizeClass(title: string): string {
  const len = title.length
  if (len <= 80) return ''
  if (len <= 160) return 'text-sm'
  return 'text-xs'
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
 * Priority badge for the indicators line — spelled-out label with colored background.
 */
function getPriorityBadge(
  priority: number,
): { label: string; bg: string; text: string; title: string } | null {
  switch (priority) {
    case 1:
      return { label: 'Low', bg: 'bg-zinc-500/15', text: 'text-zinc-500', title: 'Low priority' }
    case 2:
      return {
        label: 'Medium',
        bg: 'bg-amber-500/15',
        text: 'text-amber-600 dark:text-amber-400',
        title: 'Medium priority',
      }
    case 3:
      return {
        label: 'High',
        bg: 'bg-orange-500/15',
        text: 'text-orange-600 dark:text-orange-400',
        title: 'High priority',
      }
    case 4:
      return {
        label: 'Urgent',
        bg: 'bg-red-500/15',
        text: 'text-red-600 dark:text-red-400',
        title: 'Urgent priority',
      }
    default:
      return null
  }
}

/**
 * Priority icon indicator — compact symbols: ● for Low/Medium, ! for High, !! for Urgent.
 */
function getPriorityIcon(
  priority: number,
): { icon: string; color: string; title: string; className: string } | null {
  switch (priority) {
    case 1:
      return {
        icon: '●',
        color: 'text-zinc-400',
        title: 'Low priority',
        className: 'text-[10px]',
      }
    case 2:
      return {
        icon: '●',
        color: 'text-amber-500',
        title: 'Medium priority',
        className: 'text-[10px]',
      }
    case 3:
      return {
        icon: '!',
        color: 'text-orange-500',
        title: 'High priority',
        className: 'text-sm font-bold',
      }
    case 4:
      return {
        icon: '!!',
        color: 'text-red-500',
        title: 'Urgent priority',
        className: 'text-sm font-bold',
      }
    default:
      return null
  }
}
