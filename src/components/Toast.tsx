'use client'

import { useEffect } from 'react'

interface ToastProps {
  message: string
  action?: {
    label: string
    onClick: () => void
  }
  onDismiss: () => void
  duration?: number
}

export function Toast({ message, action, onDismiss, duration = 5000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration)
    return () => clearTimeout(timer)
  }, [onDismiss, duration])

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 animate-slide-up"
    >
      <div className="flex items-center gap-3 px-4 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg shadow-lg">
        <span className="text-sm font-medium">{message}</span>

        {action && (
          <button
            onClick={() => {
              action.onClick()
              onDismiss()
            }}
            className="text-sm font-semibold text-blue-400 dark:text-blue-600 hover:text-blue-300 dark:hover:text-blue-500"
          >
            {action.label}
          </button>
        )}

        <button
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="ml-2 text-zinc-400 dark:text-zinc-600 hover:text-zinc-300 dark:hover:text-zinc-500"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
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
    </div>
  )
}
