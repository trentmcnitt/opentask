'use client'

import { useEffect, useState, useRef } from 'react'
import { ArrowRight, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDueTimeParts } from '@/lib/format-date'
import { URGENT_PRIORITY } from '@/lib/priority'

/**
 * Auto-dismiss countdown with hover-pause and a draining SVG ring around the X button.
 *
 * Two effects work together:
 * 1. Content-reset effect: resets elapsed time when content changes (quick take text
 *    or enrichment). Defined first so React runs it before the timer effect.
 * 2. Timer effect: manages the auto-dismiss setTimeout with hover-pause support.
 *    Its cleanup saves elapsed time so hover→unhover resumes correctly.
 *
 * The SVG ring animation uses `contentKey` as its React key to remount and restart
 * the CSS animation when content changes, and `animation-play-state` for hover pause.
 */

const DISMISS_MS = 12_000
const RING_RADIUS = 10
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

interface QuickTakeBannerProps {
  title: string
  quickTakeText: string | null
  loading?: boolean
  enrichment?: { title?: string; due_at?: string | null; priority?: number } | null
  timezone: string
  onDismiss: () => void
  onViewTask?: () => void
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
  onViewTask,
}: QuickTakeBannerProps) {
  const [hovered, setHovered] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elapsedRef = useRef(0)
  const timerStartRef = useRef(0)

  // Countdown starts once loading finishes and we have displayable content
  const shouldCountdown = !loading && (!!quickTakeText || !!enrichment)

  // Stable key derived from content — changes when quick take or enrichment updates.
  // Used as the SVG circle key (remounts → restarts CSS animation) and as an effect
  // dependency (restarts the JS timer).
  const contentKey = `${quickTakeText ?? ''}|${enrichment?.title ?? ''}|${enrichment?.due_at ?? ''}`

  // Reset countdown elapsed time when new content arrives.
  // Defined before the timer effect so React runs it first (resets elapsed before
  // the timer effect reads it on the same render cycle).
  useEffect(() => {
    elapsedRef.current = 0
  }, [contentKey])

  // Auto-dismiss timer: pauses on hover, resumes with remaining time on mouse-leave.
  // The countdown-drain CSS animation on the SVG ring stays in sync via animation-play-state.
  useEffect(() => {
    if (!shouldCountdown || hovered) return

    const remaining = DISMISS_MS - elapsedRef.current
    if (remaining <= 0) {
      onDismiss()
      return
    }

    timerStartRef.current = Date.now()
    timerRef.current = setTimeout(onDismiss, remaining)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (timerStartRef.current) {
        elapsedRef.current += Date.now() - timerStartRef.current
        timerStartRef.current = 0
      }
    }
  }, [shouldCountdown, hovered, onDismiss, contentKey])

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

  // Conditional bottom padding: dots need room to breathe, title-only should be compact
  const showDots = loading && !quickTakeText
  const bottomPadding = showDots ? 'pb-3' : quickTakeText ? 'pb-2' : 'pb-1.5'

  return (
    <div
      className={cn(
        'animate-in fade-in slide-in-from-top-2 mb-3 flex w-fit max-w-full gap-2 rounded-lg border border-indigo-200/50 bg-indigo-50/50 px-3 pt-2 transition-all duration-300 dark:border-indigo-800/50 dark:bg-indigo-950/30',
        bottomPadding,
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
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
            className="mt-2 flex items-center gap-1 text-indigo-500 dark:text-indigo-400"
            aria-label="Generating insight"
          >
            <span className="typing-dot" style={{ animationDelay: '0s' }} />
            <span className="typing-dot" style={{ animationDelay: '0.2s' }} />
            <span className="typing-dot" style={{ animationDelay: '0.4s' }} />
          </div>
        ) : quickTakeText ? (
          <p className="mt-1 text-sm text-indigo-600 dark:text-indigo-300">{quickTakeText}</p>
        ) : null}

        {/* "View" link — appears once enrichment has updated the task */}
        {onViewTask && enrichment && (
          <button
            type="button"
            onClick={onViewTask}
            className="animate-in fade-in mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-indigo-500 transition-colors duration-200 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-200"
          >
            View task
            <ArrowRight className="size-3" />
          </button>
        )}
      </div>

      {/* Dismiss button with countdown ring */}
      <button
        type="button"
        onClick={onDismiss}
        className="relative mt-0.5 flex size-6 flex-shrink-0 items-center justify-center rounded text-indigo-400 transition-colors hover:text-indigo-600 dark:text-indigo-500 dark:hover:text-indigo-300"
        aria-label="Dismiss"
      >
        {shouldCountdown && (
          <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox="0 0 24 24">
            {/* Faint track — shows the full ring path */}
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="opacity-15"
            />
            {/* Animated drain — shrinks from full to empty over DISMISS_MS */}
            <circle
              key={contentKey}
              cx="12"
              cy="12"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="opacity-40"
              style={{
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: 0,
                animation: `countdown-drain ${DISMISS_MS}ms linear forwards`,
                animationPlayState: hovered ? 'paused' : 'running',
              }}
            />
          </svg>
        )}
        <X className="relative size-3.5" />
      </button>
    </div>
  )
}
