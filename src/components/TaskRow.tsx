'use client'

import { useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Check, Clock, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { formatDueTime } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import type { Task } from '@/types'

function useLongPress(onLongPress?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)

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
      origin.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
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

  return { onPointerDown, onPointerUp, onPointerMove, onPointerLeave: cancel }
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
}: TaskRowProps) {
  const timezone = useTimezone()
  const pointer = useLongPress(onSelect)

  // Expose long-press cancel function to parent (SwipeableRow)
  useEffect(() => {
    if (cancelLongPressRef) {
      cancelLongPressRef.current = pointer.onPointerLeave
    }
  }, [cancelLongPressRef, pointer.onPointerLeave])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isSelectionMode && onSelect) {
        e.preventDefault()
        if (e.shiftKey && onRangeSelect) {
          onRangeSelect()
        } else {
          onSelect()
        }
      }
    },
    [isSelectionMode, onSelect, onRangeSelect],
  )

  const priorityIndicator = getPriorityIndicator(task.priority)

  return (
    <div
      onClick={handleClick}
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

          {task.snoozed_from && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              snoozed
            </Badge>
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          {task.due_at && (
            <span
              className={cn(
                'text-sm',
                isOverdue ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}
            >
              {formatDueTime(task.due_at, timezone)}
            </span>
          )}

          {task.labels.length > 0 && (
            <div className="flex gap-1">
              {task.labels.slice(0, 2).map((label) => (
                <Badge key={label} variant="secondary" className="px-1.5 py-0 text-xs">
                  {label}
                </Badge>
              ))}
              {task.labels.length > 2 && (
                <span className="text-muted-foreground text-xs">+{task.labels.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Snooze button (hidden in selection mode) */}
      {!isSelectionMode && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation()
            onSnooze()
          }}
          aria-label={`Snooze "${task.title}"`}
          className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          title="Snooze"
        >
          <Clock className="size-4" />
        </Button>
      )}
    </div>
  )
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
