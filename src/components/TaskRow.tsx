'use client'

import { useRef, useCallback, useEffect, useState } from 'react'
import { useLongPress } from '@/hooks/useLongPress'
import Link from 'next/link'
import { Check, Clock, Repeat, Timer, TimerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { formatDueTimeParts, formatOriginalDueAt } from '@/lib/format-date'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { useTimezone } from '@/hooks/useTimezone'
import { useLabelConfig, useSnoozePreferences } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { computeSnoozeTime } from '@/lib/snooze'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import type { Task, LabelConfig } from '@/types'

/**
 * TaskRow visual reference — complete rendered examples:
 *
 *   Line 1: [priority] [title] [recurrence icon] [auto-snooze icon] [labels]
 *   Line 2: [relative time] · [absolute time] · [recurrence text] · [snoozed from X]
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
  /** Optional annotation line below metadata (e.g., AI reason from Bubble) */
  annotation?: string
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
}: TaskRowProps) {
  const timezone = useTimezone()
  const { labelConfig, priorityDisplay } = useLabelConfig()
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
      // Fallback for keyboard activation (Enter/Space) — pointer path won't set snoozeFiredRef
      const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
      onSnooze(task.id, until)
    },
    [task.id, defaultSnoozeOption, timezone, morningTime, onSnooze],
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
      // Quick tap: timer was running but long-press didn't fire → trigger snooze
      if (!snoozeFiredRef.current) {
        snoozeFiredRef.current = true // suppress any subsequent click
        const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
        onSnooze(task.id, until)
      }
    },
    [task.id, defaultSnoozeOption, timezone, morningTime, onSnooze],
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

  const leadingPriorityIndicator = getLeadingPriorityIndicator(task.priority)
  const trailingPriorityIndicator = getTrailingPriorityIndicator(task.priority)
  const priorityColors = getPriorityColors(task.priority)
  // Only treat as "snoozed" if it's a recurring task - for one-off tasks,
  // changing the due date is just changing the due date, not snoozing
  const isSnoozed = !!task.original_due_at && !!task.rrule
  const isAiProcessing = task.labels.includes('ai-to-process')
  const metaSegments = buildMetaSegments(task, timezone, isOverdue)
  // Filter ai-to-process from visible label count (animation conveys that state)
  const visibleLabelCount = task.labels.filter((l) => l !== 'ai-to-process').length
  const hasLabels = visibleLabelCount > 0
  const hasLine2 = metaSegments.length > 0
  const iconHeight = getIconAlignHeight(task.title)

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
          className="border-muted-foreground/30 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors hover:border-green-500 hover:bg-green-500/10"
          title={task.rrule ? 'Advance to next occurrence' : 'Mark as done'}
        >
          <Check
            className="size-4 text-transparent transition-colors group-hover:text-green-500"
            strokeWidth={3}
          />
        </button>
      )}

      {/* Task content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {leadingPriorityIndicator && (
            <span
              className={cn(
                'flex flex-shrink-0 items-center text-sm font-bold',
                iconHeight,
                leadingPriorityIndicator.color,
              )}
              title={leadingPriorityIndicator.title}
            >
              {leadingPriorityIndicator.icon}
            </span>
          )}

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

          {priorityDisplay.trailingDot && trailingPriorityIndicator && (
            <span
              className={cn(
                '-ml-1 flex flex-shrink-0 items-center text-[10px]',
                iconHeight,
                trailingPriorityIndicator.color,
              )}
              title={trailingPriorityIndicator.title}
            >
              ●
            </span>
          )}

          {task.rrule && (
            <span
              className={cn('text-muted-foreground flex shrink-0 items-center', iconHeight)}
              title="Recurring"
            >
              <Repeat className="size-3.5" />
            </span>
          )}

          {task.auto_snooze_minutes !== null && task.auto_snooze_minutes === 0 ? (
            <span
              className={cn('text-muted-foreground flex shrink-0 items-center', iconHeight)}
              title="Auto-snooze off"
            >
              <TimerOff className="size-3.5" />
            </span>
          ) : task.auto_snooze_minutes !== null && task.auto_snooze_minutes > 0 ? (
            <span
              className={cn('text-muted-foreground flex shrink-0 items-center gap-0.5', iconHeight)}
              title={`Auto-snooze: ${formatAutoSnoozeLabel(task.auto_snooze_minutes)}`}
            >
              <Timer className="size-3.5" />
              <span className="text-xs">{formatAutoSnoozeLabel(task.auto_snooze_minutes)}</span>
            </span>
          ) : null}

          {hasLabels && (
            <span className={cn('flex shrink-0 items-center', iconHeight)}>
              <LabelBadges
                labels={task.labels}
                labelConfig={labelConfig}
                onLabelClick={onLabelClick}
              />
            </span>
          )}
        </div>

        {hasLine2 && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-sm">
            {metaSegments.map((seg, i) => (
              <span key={i} className="contents">
                <span className={cn('whitespace-nowrap', seg.className)}>{seg.text}</span>
                {i < metaSegments.length - 1 && <span className="text-muted-foreground/50">·</span>}
              </span>
            ))}
          </div>
        )}

        {annotation && (
          <p className="mt-0.5 line-clamp-2 text-xs text-blue-600/80 dark:text-blue-400/80">
            {annotation}
          </p>
        )}
      </div>

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
}: {
  labels: string[]
  labelConfig: LabelConfig[]
  onLabelClick?: (label: string) => void
}) {
  // Filter out ai-to-process (the animation conveys that state)
  const visibleLabels = labels.filter((l) => l !== 'ai-to-process')

  return (
    <div className="flex flex-shrink-0 gap-1">
      {visibleLabels.slice(0, 2).map((label) => {
        const colorClasses = getLabelClasses(label, labelConfig)
        return (
          <Badge
            key={label}
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

  if (task.due_at) {
    const dueParts = formatDueTimeParts(task.due_at, timezone)
    segments.push({
      text: dueParts.relative,
      className: isOverdue ? 'text-destructive font-medium' : undefined,
    })
    if (dueParts.absolute) {
      segments.push({ text: dueParts.absolute })
    }
  }

  if (task.rrule) {
    segments.push({ text: formatRRuleCompact(task.rrule, task.anchor_time) })
  }

  // Only show "snoozed from" for recurring tasks - for one-offs, it's just a due date change
  if (task.original_due_at && task.rrule) {
    const text = formatOriginalDueAt(task.original_due_at, timezone)
    if (text) {
      segments.push({ text, className: 'text-blue-400' })
    }
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
 * Height class matching the text line-height for the title tier.
 * Used on indicator spans (with `flex items-center`) so icons are
 * vertically centered against the first line of text when the
 * parent uses `items-start`.
 */
function getIconAlignHeight(title: string): string {
  const len = title.length
  if (len <= 80) return 'h-6' // 24px = text-base line-height
  if (len <= 160) return 'h-5' // 20px = text-sm line-height
  return 'h-4' // 16px = text-xs line-height
}

/**
 * Priority color classes for different UI elements
 */
function getPriorityColors(priority: number): {
  text: string
  border: string
} | null {
  switch (priority) {
    case 1:
      return { text: 'text-zinc-400', border: 'border-r-zinc-400' }
    case 2:
      return { text: 'text-amber-500', border: 'border-r-amber-500' }
    case 3:
      return { text: 'text-orange-500', border: 'border-r-orange-500' }
    case 4:
      return { text: 'text-red-500', border: 'border-r-red-500' }
    default:
      return null
  }
}

/**
 * Leading priority indicator (before title) - only for high/urgent
 */
function getLeadingPriorityIndicator(
  priority: number,
): { icon: string; color: string; title: string } | null {
  switch (priority) {
    case 3:
      return { icon: '!', color: 'text-orange-500', title: 'High priority' }
    case 4:
      return { icon: '!!', color: 'text-red-500', title: 'Urgent priority' }
    default:
      return null
  }
}

/**
 * Trailing priority indicator (after title) - only for medium/low
 */
function getTrailingPriorityIndicator(priority: number): { color: string; title: string } | null {
  switch (priority) {
    case 1:
      return { color: 'text-zinc-400', title: 'Low priority' }
    case 2:
      return { color: 'text-amber-500', title: 'Medium priority' }
    default:
      return null
  }
}
