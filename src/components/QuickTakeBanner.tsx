'use client'

import { useEffect } from 'react'
import { Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDueTimeParts } from '@/lib/format-date'
import { URGENT_PRIORITY } from '@/lib/priority'

interface QuickTakeBannerProps {
  title: string
  quickTakeText: string | null
  loading?: boolean
  enrichment?: { title?: string; due_at?: string | null; priority?: number } | null
  timezone: string
  onDismiss: () => void
}

/**
 * Format a due date for the compact banner chip.
 * Strips the time portion to keep it short: "Tomorrow" not "Tomorrow 9:00 AM".
 */
function formatDueChip(dueAt: string, timezone: string): string {
  const { relative } = formatDueTimeParts(dueAt, timezone)
  // Strip time from multi-word relatives like "Tomorrow 9:00 AM" → "Tomorrow"
  // Keep single-word or countdown formats ("in 2h", "3d ago") as-is
  return relative.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)/i, '')
}

const PRIORITY_CHIP_LABELS: Record<number, string> = {
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
}

export function QuickTakeBanner({
  title,
  quickTakeText,
  loading,
  enrichment,
  timezone,
  onDismiss,
}: QuickTakeBannerProps) {
  // Auto-dismiss after 12s — reset when enrichment arrives or quick take text changes
  useEffect(() => {
    if (loading) return
    // Need at least one piece of content to stay visible
    if (!quickTakeText && !enrichment) return
    const timer = setTimeout(onDismiss, 12000)
    return () => clearTimeout(timer)
  }, [quickTakeText, loading, enrichment, onDismiss])

  const displayTitle = enrichment?.title ?? title
  const dueAt = enrichment?.due_at
  const priority = enrichment?.priority

  // Build metadata chips
  const chips: Array<{ key: string; label: string; urgent?: boolean }> = []
  if (dueAt) {
    chips.push({ key: 'due', label: formatDueChip(dueAt, timezone) })
  }
  if (priority && priority >= 2) {
    const label = PRIORITY_CHIP_LABELS[priority]
    if (label) {
      chips.push({ key: 'priority', label, urgent: priority === URGENT_PRIORITY })
    }
  }

  return (
    <div className="animate-in fade-in slide-in-from-top-2 mb-3 flex w-fit max-w-full gap-2 rounded-lg border border-indigo-200/50 bg-indigo-50/50 px-3 py-2 transition-all duration-300 dark:border-indigo-800/50 dark:bg-indigo-950/30">
      <Sparkles className="mt-0.5 size-3.5 flex-shrink-0 text-indigo-500 dark:text-indigo-400" />

      <div className="min-w-0 flex-1">
        {/* Row 1: Title + metadata chips */}
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
            {displayTitle}
          </span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={cn(
                'animate-in fade-in inline-flex text-xs duration-300',
                chip.urgent
                  ? 'font-medium text-red-600 dark:text-red-400'
                  : 'text-indigo-500 dark:text-indigo-400',
              )}
            >
              {'· '}
              {chip.label}
            </span>
          ))}
        </div>

        {/* Row 2: Quick take text or typing dots */}
        {loading && !quickTakeText ? (
          <div
            className="mt-1 flex items-center gap-1 text-indigo-500 dark:text-indigo-400"
            aria-label="Generating insight"
          >
            <span className="typing-dot" style={{ animationDelay: '0s' }} />
            <span className="typing-dot" style={{ animationDelay: '0.2s' }} />
            <span className="typing-dot" style={{ animationDelay: '0.4s' }} />
          </div>
        ) : quickTakeText ? (
          <p className="mt-0.5 text-sm text-indigo-600 dark:text-indigo-300">{quickTakeText}</p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        className="mt-0.5 flex-shrink-0 rounded p-0.5 text-indigo-400 transition-colors hover:text-indigo-600 dark:text-indigo-500 dark:hover:text-indigo-300"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
