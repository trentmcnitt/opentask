'use client'

import { useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Check, Clock, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { formatDueTimeParts, formatSnoozedFrom } from '@/lib/format-date'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { useTimezone } from '@/hooks/useTimezone'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import type { Task, LabelConfig } from '@/types'

/**
 * TaskRow visual reference — complete rendered examples:
 *
 *   Line 1: [priority] [title] [recurrence icon] [labels]
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

function useLongPress(onLongPress?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onLongPress) return
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        onLongPress()
      }, 400)
    },
    [onLongPress],
  )

  const onPointerUp = useCallback(() => {
    cancel()
  }, [cancel])

  // Only cancel long-press if pointer moves >10px (ignore sub-pixel jitter)
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!timer.current || !origin.current) return
    const dx = e.clientX - origin.current.x
    const dy = e.clientY - origin.current.y
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  /** True if the most recent pointer interaction triggered the long-press callback */
  const didFire = useCallback(() => {
    const result = fired.current
    fired.current = false
    return result
  }, [])

  return { onPointerDown, onPointerUp, onPointerMove, onPointerLeave: cancel, didFire }
}

interface TaskRowProps {
  task: Task
  onDone: () => void
  onSnooze: () => void
  isOverdue?: boolean
  isSelected?: boolean
  isSelectionMode?: boolean
  onSelect?: () => void
  onRangeSelect?: () => void
  cancelLongPressRef?: React.MutableRefObject<(() => void) | null>
  onLabelClick?: (label: string) => void
  onFocus?: () => void
}

export function TaskRow({
  task,
  onDone,
  onSnooze,
  isOverdue,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onRangeSelect,
  cancelLongPressRef,
  onLabelClick,
  onFocus,
}: TaskRowProps) {
  const timezone = useTimezone()
  const { labelConfig } = useLabelConfig()
  // Long-press: range-select when already in selection mode, otherwise toggle
  const longPressAction = isSelectionMode && onRangeSelect ? onRangeSelect : onSelect
  const pointer = useLongPress(longPressAction)

  // Expose long-press cancel function to parent (SwipeableRow)
  useEffect(() => {
    if (cancelLongPressRef) {
      cancelLongPressRef.current = pointer.onPointerLeave
    }
  }, [cancelLongPressRef, pointer.onPointerLeave])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Suppress click that follows a long-press
      if (pointer.didFire()) {
        e.preventDefault()
        return
      }

      // Clicking anywhere on the row (except interactive elements with stopPropagation)
      // enters selection mode and selects this task
      if (!onSelect) return
      e.preventDefault()
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect()
      } else {
        onSelect()
      }
    },
    [onSelect, onRangeSelect, pointer],
  )

  const priorityIndicator = getPriorityIndicator(task.priority)
  const isSnoozed = !!task.snoozed_from
  const metaSegments = buildMetaSegments(task, timezone, isOverdue)
  const hasLabels = task.labels.length > 0
  const hasLine2 = metaSegments.length > 0

  return (
    <div
      onClick={handleClick}
      onMouseEnter={onFocus}
      onPointerDown={pointer.onPointerDown}
      onPointerUp={pointer.onPointerUp}
      onPointerMove={pointer.onPointerMove}
      onPointerLeave={pointer.onPointerLeave}
      onPointerCancel={pointer.onPointerUp}
      className={cn(
        'group flex items-center gap-3 rounded-lg p-3 select-none',
        'bg-card border',
        'hover:border-border/80 transition-colors',
        isOverdue && 'border-l-destructive border-l-4',
        !isOverdue && isSnoozed && 'border-l-4 border-l-blue-400',
        isSelected && 'ring-ring bg-accent ring-2',
        isSelectionMode && 'cursor-pointer',
      )}
    >
      {/* Selection checkbox (shown in selection mode) or Done button */}
      {isSelectionMode ? (
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelect?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select "${task.title}"`}
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
        <div className="flex items-center gap-2">
          {priorityIndicator && (
            <span
              className={cn('flex-shrink-0 text-sm font-bold', priorityIndicator.color)}
              title={priorityIndicator.title}
            >
              {priorityIndicator.icon}
            </span>
          )}

          {isSelectionMode ? (
            <span className="truncate font-medium">{task.title}</span>
          ) : (
            <Link
              href={`/tasks/${task.id}`}
              className="truncate font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {task.title}
            </Link>
          )}

          {task.rrule && (
            <span className="text-muted-foreground flex-shrink-0" title="Recurring">
              <Repeat className="size-3.5" />
            </span>
          )}

          {hasLabels && (
            <LabelBadges
              labels={task.labels}
              labelConfig={labelConfig}
              onLabelClick={onLabelClick}
            />
          )}
        </div>

        {hasLine2 && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-sm">
            {metaSegments.map((seg, i) => (
              <span key={i} className={cn('whitespace-nowrap', seg.className)}>
                {i > 0 && <span className="text-muted-foreground/50 mr-1">·</span>}
                {seg.text}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Snooze button (hidden in selection mode and on mobile — swipe-to-snooze is the mobile interaction) */}
      {!isSelectionMode && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation()
            onSnooze()
          }}
          aria-label={`Snooze "${task.title}"`}
          className="hidden flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 md:flex"
          title="Snooze"
        >
          <Clock className="size-4" />
        </Button>
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
  return (
    <div className="flex flex-shrink-0 gap-1">
      {labels.slice(0, 2).map((label) => {
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
      {labels.length > 2 && (
        <span className="text-muted-foreground text-xs">+{labels.length - 2}</span>
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
    segments.push({ text: formatRRuleCompact(task.rrule) })
  }

  if (task.snoozed_from) {
    const text = formatSnoozedFrom(task.snoozed_from, timezone)
    if (text) {
      segments.push({ text, className: 'text-blue-400' })
    }
  }

  return segments
}

function getPriorityIndicator(
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
