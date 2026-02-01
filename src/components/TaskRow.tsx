'use client'

import { useRef, useCallback } from 'react'
import Link from 'next/link'
import { Check, Clock, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface TaskRowProps {
  task: Task
  onDone: () => void
  onSnooze: () => void
  isOverdue?: boolean
  isSelected?: boolean
  isSelectionMode?: boolean
  onSelect?: () => void
  onRangeSelect?: () => void
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
}: TaskRowProps) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handlePointerDown = useCallback(() => {
    if (!onSelect) return
    longPressTimer.current = setTimeout(() => {
      onSelect()
    }, 400)
  }, [onSelect])

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isSelectionMode && onSelect) {
      e.preventDefault()
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect()
      } else {
        onSelect()
      }
    }
  }, [isSelectionMode, onSelect, onRangeSelect])

  const formatDueTime = (dueAt: string | null) => {
    if (!dueAt) return null

    const due = new Date(dueAt)
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)

    const time = due.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    if (due < today) {
      return due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time
    } else if (due < tomorrow) {
      return time
    } else if (due < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) {
      return 'Tomorrow ' + time
    } else {
      return due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    }
  }

  const priorityIndicator = getPriorityIndicator(task.priority)

  return (
    <div
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        "group flex items-center gap-3 p-3 rounded-lg",
        "bg-card border",
        "hover:border-border/80 transition-colors",
        isOverdue && "border-l-4 border-l-destructive",
        isSelected && "ring-2 ring-ring bg-accent",
        isSelectionMode && "cursor-pointer"
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
          onClick={(e) => { e.stopPropagation(); onDone() }}
          aria-label={task.rrule ? `Advance "${task.title}" to next occurrence` : `Mark "${task.title}" as done`}
          className="flex-shrink-0 w-6 h-6 rounded-full border-2 border-muted-foreground/30 hover:border-green-500 hover:bg-green-500/10 transition-colors flex items-center justify-center"
          title={task.rrule ? 'Advance to next occurrence' : 'Mark as done'}
        >
          <Check className="size-4 text-transparent group-hover:text-green-500 transition-colors" strokeWidth={3} />
        </button>
      )}

      {/* Task content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {priorityIndicator && (
            <span className={cn("flex-shrink-0 text-sm font-bold", priorityIndicator.color)} title={priorityIndicator.title}>
              {priorityIndicator.icon}
            </span>
          )}

          {isSelectionMode ? (
            <span className="font-medium truncate">{task.title}</span>
          ) : (
            <Link
              href={`/tasks/${task.id}`}
              className="font-medium truncate hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {task.title}
            </Link>
          )}

          {task.rrule && (
            <span className="flex-shrink-0 text-muted-foreground" title="Recurring">
              <Repeat className="size-3.5" />
            </span>
          )}

          {task.snoozed_from && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              snoozed
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 mt-0.5">
          {task.due_at && (
            <span className={cn(
              "text-sm",
              isOverdue ? "text-destructive font-medium" : "text-muted-foreground"
            )}>
              {formatDueTime(task.due_at)}
            </span>
          )}

          {task.labels.length > 0 && (
            <div className="flex gap-1">
              {task.labels.slice(0, 2).map((label) => (
                <Badge key={label} variant="secondary" className="text-xs px-1.5 py-0">
                  {label}
                </Badge>
              ))}
              {task.labels.length > 2 && (
                <span className="text-xs text-muted-foreground">+{task.labels.length - 2}</span>
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
          onClick={(e) => { e.stopPropagation(); onSnooze() }}
          aria-label={`Snooze "${task.title}"`}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          title="Snooze"
        >
          <Clock className="size-4" />
        </Button>
      )}
    </div>
  )
}

function getPriorityIndicator(priority: number): { icon: string; color: string; title: string } | null {
  switch (priority) {
    case 3:
      return { icon: '!', color: 'text-orange-500', title: 'High priority' }
    case 4:
      return { icon: '!!', color: 'text-red-500', title: 'Urgent priority' }
    default:
      return null
  }
}
