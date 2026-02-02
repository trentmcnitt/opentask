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
      className="animate-slide-up fixed bottom-4 left-1/2 z-50 -translate-x-1/2"
    >
      <div className="bg-foreground text-background flex items-center gap-3 rounded-lg px-4 py-3 shadow-lg">
        <span className="text-sm font-medium">{message}</span>

        {action && (
          <button
            onClick={() => {
              action.onClick()
              onDismiss()
            }}
            className="text-sm font-semibold text-blue-400 hover:text-blue-300 dark:text-blue-600 dark:hover:text-blue-500"
          >
            {action.label}
          </button>
        )}

        <button
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="text-background/60 hover:text-background/80 ml-2"
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
