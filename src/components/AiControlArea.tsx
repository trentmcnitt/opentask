'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { AiMode } from '@/hooks/useAiMode'

interface AiControlAreaProps {
  mode: AiMode
  onModeChange: (mode: AiMode) => void
  showScores: boolean
  onShowScoresChange: (show: boolean) => void
  showSignals: boolean
  onShowSignalsChange: (show: boolean) => void
  hasScores: boolean
  // Bubble
  bubbleFreshnessText: string | null
  bubbleLoading: boolean
  onRefreshBubble: () => void
  // Review
  reviewGeneratedAt: string | null
  reviewGenerating: boolean
  reviewProgress: number
  reviewCompletedTasks: number
  reviewTotalTasks: number
  onGenerateReview: () => void
}

const MODE_OPTIONS: { value: AiMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'bubble', label: 'Bubble' },
  { value: 'insight', label: 'Insight' },
]

/**
 * AI control area rendered between QuickAdd and FilterBar.
 *
 * Layout:
 *   ✨ [Off | Bubble | Insight]  ☐ Scores  ☐ Signals  · 2h ago ↻
 *   [==================     ] 15/84 (18%)     ← only during generation
 */
export function AiControlArea({
  mode,
  onModeChange,
  showScores,
  onShowScoresChange,
  showSignals,
  onShowSignalsChange,
  hasScores,
  bubbleFreshnessText,
  bubbleLoading,
  onRefreshBubble,
  reviewGeneratedAt,
  reviewGenerating,
  reviewProgress,
  reviewCompletedTasks,
  reviewTotalTasks,
  onGenerateReview,
}: AiControlAreaProps) {
  return (
    <div className="mb-4 space-y-2">
      {/* Main control row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Sparkle icon + segmented toggle */}
        <div className="flex items-center gap-1.5">
          <Sparkles className="text-muted-foreground size-3.5" />
          <div className="bg-muted inline-flex rounded-lg p-0.5">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onModeChange(opt.value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-all',
                  mode === opt.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scores checkbox */}
        {hasScores && mode !== 'off' && (
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={showScores}
              onCheckedChange={(checked) => onShowScoresChange(checked === true)}
              className="size-3.5"
            />
            <span className="text-muted-foreground">Scores</span>
          </label>
        )}

        {/* Signals checkbox */}
        {hasScores && mode !== 'off' && (
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={showSignals}
              onCheckedChange={(checked) => onShowSignalsChange(checked === true)}
              className="size-3.5"
            />
            <span className="text-muted-foreground">Signals</span>
          </label>
        )}

        {/* Bubble: freshness + refresh (blue) */}
        {mode === 'bubble' && (
          <div className="flex items-center gap-1.5">
            {bubbleFreshnessText && (
              <TimestampTooltip
                label="Bubble AI"
                rawDate={null}
                freshnessText={bubbleFreshnessText}
                colorClass="text-blue-500"
              />
            )}
            <button
              onClick={() => {
                if (!bubbleLoading) onRefreshBubble()
              }}
              disabled={bubbleLoading}
              className="rounded-full p-0.5 text-blue-500 transition-colors hover:text-blue-600 disabled:opacity-40"
              aria-label="Refresh AI insights"
            >
              <RefreshCw className={cn('size-3', bubbleLoading && 'animate-spin')} />
            </button>
          </div>
        )}

        {/* Insight: timestamp + generate/refresh (indigo) */}
        {mode === 'insight' && (
          <div className="flex items-center gap-1.5">
            {reviewGeneratedAt && !reviewGenerating && (
              <TimestampTooltip
                label="AI Review"
                rawDate={reviewGeneratedAt}
                freshnessText={null}
                colorClass="text-indigo-500"
              />
            )}
            <button
              onClick={onGenerateReview}
              disabled={reviewGenerating}
              className="rounded-full p-0.5 text-indigo-500 transition-colors hover:text-indigo-600 disabled:opacity-40"
              aria-label={hasScores ? 'Refresh review' : 'Generate review'}
            >
              {reviewGenerating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Progress bar (Insight mode, during generation only) */}
      {mode === 'insight' && reviewGenerating && (
        <div>
          <div className="bg-muted mb-1 h-2 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${reviewProgress}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Processing tasks... {reviewCompletedTasks}/{reviewTotalTasks} ({reviewProgress}%)
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Timestamp text with hover/tap tooltip.
 *
 * Desktop: hover shows the styled tooltip immediately; click also toggles it.
 * Mobile/touch: tapping toggles the tooltip, which auto-dismisses after 3s.
 */
function TimestampTooltip({
  label,
  rawDate,
  freshnessText,
  colorClass,
}: {
  label: string
  rawDate: string | null
  freshnessText: string | null
  colorClass: string
}) {
  const [showTooltip, setShowTooltip] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fullDate = rawDate
    ? new Date(rawDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null

  const displayText =
    freshnessText ??
    (rawDate
      ? new Date(rawDate).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null)

  const tooltipText = `${label} · ${fullDate ?? freshnessText ?? ''}`

  const dismiss = useCallback(() => {
    setShowTooltip(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    setShowTooltip((prev) => {
      if (!prev) {
        timerRef.current = setTimeout(() => {
          setShowTooltip(false)
          timerRef.current = null
        }, 3000)
        return true
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return false
    })
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // Dismiss on outside click
  const containerRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!showTooltip) return
    const handler = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        dismiss()
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [showTooltip, dismiss])

  if (!displayText) return null

  return (
    <span
      ref={containerRef}
      className="relative flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={dismiss}
    >
      <button onClick={toggle} className={cn('text-xs leading-none', colorClass)} type="button">
        {displayText}
      </button>
      {showTooltip && (
        <span className="bg-foreground text-background absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 rounded px-2 py-1 text-xs font-medium whitespace-nowrap shadow-lg">
          {tooltipText}
        </span>
      )}
    </span>
  )
}
