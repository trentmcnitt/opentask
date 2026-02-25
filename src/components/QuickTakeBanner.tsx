'use client'

import { useEffect } from 'react'
import { Sparkles, X } from 'lucide-react'

interface QuickTakeBannerProps {
  text: string
  onDismiss: () => void
}

export function QuickTakeBanner({ text, onDismiss }: QuickTakeBannerProps) {
  // Auto-dismiss after 12 seconds
  useEffect(() => {
    const timer = setTimeout(onDismiss, 12000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="animate-in fade-in slide-in-from-top-2 mb-3 flex items-start gap-2 rounded-lg border border-indigo-200/50 bg-indigo-50/50 px-3 py-2 duration-300 dark:border-indigo-800/50 dark:bg-indigo-950/30">
      <Sparkles className="mt-0.5 size-3.5 flex-shrink-0 text-indigo-500 dark:text-indigo-400" />
      <p className="min-w-0 flex-1 text-sm text-indigo-700 dark:text-indigo-300">{text}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="flex-shrink-0 rounded p-0.5 text-indigo-400 transition-colors hover:text-indigo-600 dark:text-indigo-500 dark:hover:text-indigo-300"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
