'use client'

import { useState, useEffect, useRef } from 'react'
import type { Task } from '@/types'

interface SnoozeSheetProps {
  task: Task
  onSnooze: (until: string) => void
  onClose: () => void
}

/**
 * Round to the nearest hour per SPEC:
 * minutes < 35 round down, >= 35 round up
 */
function roundToHour(date: Date): Date {
  const result = new Date(date)
  if (result.getMinutes() >= 35) {
    result.setHours(result.getHours() + 1)
  }
  result.setMinutes(0, 0, 0)
  return result
}

export function SnoozeSheet({ task, onSnooze, onClose }: SnoozeSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [customDateTime, setCustomDateTime] = useState('')

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
      case '+1h': {
        const t = roundToHour(new Date(now.getTime() + 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+2h': {
        const t = roundToHour(new Date(now.getTime() + 2 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+3h': {
        const t = roundToHour(new Date(now.getTime() + 3 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case 'tomorrow9am': {
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        return tomorrow.toISOString()
      }
      case '+1d': {
        const t = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        t.setMinutes(0, 0, 0)
        return t.toISOString()
      }
      case '+3d': {
        const t = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
        t.setHours(9, 0, 0, 0)
        return t.toISOString()
      }
      case '+1w': {
        const t = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        t.setHours(9, 0, 0, 0)
        return t.toISOString()
      }
      default:
        return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    }
  }

  const options = [
    { id: '+1h', label: '+1 hour', icon: '1h' },
    { id: '+2h', label: '+2 hours', icon: '2h' },
    { id: '+3h', label: '+3 hours', icon: '3h' },
    { id: 'tomorrow9am', label: 'Tomorrow 9 AM', icon: '9AM' },
    { id: '+1d', label: '+1 day', icon: '+1d' },
    { id: '+3d', label: '+3 days', icon: '+3d' },
    { id: '+1w', label: '+1 week', icon: '+1w' },
  ]

  const handleCustomSubmit = () => {
    if (customDateTime) {
      const dt = new Date(customDateTime)
      if (!isNaN(dt.getTime())) {
        onSnooze(dt.toISOString())
      }
    }
  }

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
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

          {/* Pick date & time button */}
          <button
            onClick={() => setShowPicker(!showPicker)}
            className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 transition-colors text-left"
          >
            <span className="flex-shrink-0 w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </span>
            <span className="text-sm font-medium">Pick date & time</span>
          </button>
        </div>

        {/* Custom datetime picker */}
        {showPicker && (
          <div className="px-4 pb-4 flex gap-2">
            <input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
              autoFocus
            />
            <button
              onClick={handleCustomSubmit}
              disabled={!customDateTime}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium disabled:opacity-50 hover:bg-blue-600 transition-colors"
            >
              Set
            </button>
          </div>
        )}

        {/* Safe area padding for mobile */}
        <div className="h-6 sm:hidden" />
      </div>
    </div>
  )
}
