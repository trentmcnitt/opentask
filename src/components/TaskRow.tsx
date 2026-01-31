'use client'

import { useRef, useCallback } from 'react'
import Link from 'next/link'
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
      className={`
        group flex items-center gap-3 p-3 rounded-lg
        bg-white dark:bg-zinc-900
        border border-zinc-200 dark:border-zinc-800
        hover:border-zinc-300 dark:hover:border-zinc-700
        transition-colors
        ${isOverdue ? 'border-l-4 border-l-red-500' : ''}
        ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/30' : ''}
        ${isSelectionMode ? 'cursor-pointer' : ''}
      `}
    >
      {/* Selection checkbox (shown in selection mode) or Done button */}
      {isSelectionMode ? (
        <div
          className={`flex-shrink-0 w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
            isSelected
              ? 'bg-blue-500 border-blue-500'
              : 'border-zinc-300 dark:border-zinc-600'
          }`}
        >
          {isSelected && (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onDone() }}
          aria-label={task.rrule ? `Advance "${task.title}" to next occurrence` : `Mark "${task.title}" as done`}
          className="flex-shrink-0 w-6 h-6 rounded-full border-2 border-zinc-300 dark:border-zinc-600 hover:border-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors flex items-center justify-center"
          title={task.rrule ? 'Advance to next occurrence' : 'Mark as done'}
        >
          <svg
            className="w-4 h-4 text-transparent group-hover:text-green-500 transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </button>
      )}

      {/* Task content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {priorityIndicator && (
            <span className={`flex-shrink-0 text-sm font-bold ${priorityIndicator.color}`} title={priorityIndicator.title}>
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
            <span className="flex-shrink-0 text-zinc-400 dark:text-zinc-500" title="Recurring">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
            </span>
          )}

          {task.snoozed_from && (
            <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
              snoozed
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-0.5">
          {task.due_at && (
            <span className={`text-sm ${isOverdue ? 'text-red-600 dark:text-red-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {formatDueTime(task.due_at)}
            </span>
          )}

          {task.labels.length > 0 && (
            <div className="flex gap-1">
              {task.labels.slice(0, 2).map((label) => (
                <span key={label} className="px-1.5 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {label}
                </span>
              ))}
              {task.labels.length > 2 && (
                <span className="text-xs text-zinc-400">+{task.labels.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Snooze button (hidden in selection mode) */}
      {!isSelectionMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onSnooze() }}
          aria-label={`Snooze "${task.title}"`}
          className="flex-shrink-0 p-2 rounded-lg text-zinc-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-300 dark:hover:bg-zinc-800 transition-all"
          title="Snooze"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
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
