'use client'

import { useEffect, useRef } from 'react'
import type { Task } from '@/types'

interface SnoozeSheetProps {
  task: Task
  onSnooze: (until: string) => void
  onClose: () => void
}

export function SnoozeSheet({ task, onSnooze, onClose }: SnoozeSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const firstOptionRef = useRef<HTMLButtonElement>(null)

  // Close on escape key and handle focus trap
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Focus trap: keep focus within the modal
      if (e.key === 'Tab' && sheetRef.current) {
        const focusableElements = sheetRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement?.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Auto-focus first option on mount
  useEffect(() => {
    firstOptionRef.current?.focus()
  }, [])

  const getSnoozeTime = (option: string): string => {
    const now = new Date()

    switch (option) {
      case '15min':
        return new Date(now.getTime() + 15 * 60 * 1000).toISOString()
      case '30min':
        return new Date(now.getTime() + 30 * 60 * 1000).toISOString()
      case '1hour':
        return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
      case '3hours':
        return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString()
      case 'tonight': {
        const tonight = new Date(now)
        tonight.setHours(20, 0, 0, 0)
        if (tonight <= now) tonight.setDate(tonight.getDate() + 1)
        return tonight.toISOString()
      }
      case 'tomorrow': {
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        return tomorrow.toISOString()
      }
      case 'weekend': {
        const weekend = new Date(now)
        const dayOfWeek = weekend.getDay()
        const daysUntilSaturday = dayOfWeek === 0 ? 6 : 6 - dayOfWeek
        weekend.setDate(weekend.getDate() + daysUntilSaturday)
        weekend.setHours(10, 0, 0, 0)
        return weekend.toISOString()
      }
      case 'nextweek': {
        const nextWeek = new Date(now)
        const dayOfWeek = nextWeek.getDay()
        const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek
        nextWeek.setDate(nextWeek.getDate() + daysUntilMonday)
        nextWeek.setHours(9, 0, 0, 0)
        return nextWeek.toISOString()
      }
      default:
        return new Date(now.getTime() + 30 * 60 * 1000).toISOString()
    }
  }

  const options = [
    { id: '15min', label: '15 minutes', icon: '15m' },
    { id: '30min', label: '30 minutes', icon: '30m' },
    { id: '1hour', label: '1 hour', icon: '1h' },
    { id: '3hours', label: '3 hours', icon: '3h' },
    { id: 'tonight', label: 'Tonight (8 PM)', icon: 'PM' },
    { id: 'tomorrow', label: 'Tomorrow (9 AM)', icon: 'AM' },
    { id: 'weekend', label: 'This Weekend', icon: 'Sat' },
    { id: 'nextweek', label: 'Next Week', icon: 'Mon' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="snooze-sheet-title"
        className="relative w-full max-w-md bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl shadow-xl animate-slide-up"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 id="snooze-sheet-title" className="text-lg font-semibold">Snooze</h2>
          <button
            onClick={onClose}
            aria-label="Close snooze options"
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Task preview */}
        <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/50">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 truncate">
            {task.title}
          </p>
        </div>

        {/* Options */}
        <div className="p-4 grid grid-cols-2 gap-2">
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={index === 0 ? firstOptionRef : undefined}
              onClick={() => onSnooze(getSnoozeTime(option.id))}
              className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 transition-colors text-left"
            >
              <span className="flex-shrink-0 w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                {option.icon}
              </span>
              <span className="text-sm font-medium">{option.label}</span>
            </button>
          ))}
        </div>

        {/* Safe area padding for mobile */}
        <div className="h-6 sm:hidden" />
      </div>
    </div>
  )
}
