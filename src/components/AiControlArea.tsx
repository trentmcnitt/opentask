'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Eye, EyeOff, RefreshCw, Sparkles } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/quick-select-dates'
import type { AiMode } from '@/hooks/useAiMode'

interface AiControlAreaProps {
  mode: AiMode
  onModeChange: (mode: AiMode) => void
  showScores: boolean
  onShowScoresChange: (show: boolean) => void
  showSignals: boolean
  onShowSignalsChange: (show: boolean) => void
  showBubbleText: boolean
  onShowBubbleTextChange: (show: boolean) => void
  showInsights: boolean
  onShowInsightsChange: (show: boolean) => void
  showCommentary: boolean
  onShowCommentaryChange: (show: boolean) => void
  // Bubble
  annotationGeneratedAt: string | null
  annotationFreshnessText: string | null
  annotationRefreshLoading: boolean
  annotationError: string | null
  onRefreshAnnotations: () => void
  // Insights (Review)
  reviewGeneratedAt: string | null
  reviewGenerating: boolean
  reviewProgress: number
  reviewCompletedTasks: number
  reviewTotalTasks: number
  reviewSingleCall: boolean
  reviewError: string | null
  onRefreshReview: () => void
}

/**
 * AI chip + popover — sits inline next to the QuickAdd input.
 *
 * The chip is a compact pill that opens a popover for configuration.
 * Two AI systems (Bubble and Insights) are clearly separated in the
 * popover with their own freshness timestamps and refresh buttons.
 *
 * When insights are generating, the AI button glows and the progress
 * bar appears inside the popover's Insights section (not on the dashboard).
 *
 * Freshness timestamps ("3h ago") show the absolute time on hover/tap.
 */
export function AiControlArea({
  mode,
  onModeChange,
  showScores,
  onShowScoresChange,
  showSignals,
  onShowSignalsChange,
  showBubbleText,
  onShowBubbleTextChange,
  showInsights,
  onShowInsightsChange,
  showCommentary,
  onShowCommentaryChange,
  annotationGeneratedAt,
  annotationFreshnessText,
  annotationRefreshLoading,
  annotationError,
  onRefreshAnnotations,
  reviewGeneratedAt,
  reviewGenerating,
  reviewProgress,
  reviewCompletedTasks,
  reviewTotalTasks,
  reviewSingleCall,
  reviewError,
  onRefreshReview,
}: AiControlAreaProps) {
  const isActive = mode !== 'off'

  const reviewFreshnessText = reviewGeneratedAt ? formatRelativeTime(reviewGeneratedAt) : null

  const handleRefreshAnnotations = useCallback(() => {
    if (!annotationRefreshLoading) onRefreshAnnotations()
  }, [annotationRefreshLoading, onRefreshAnnotations])

  const handleRefreshReview = useCallback(() => {
    if (!reviewGenerating) onRefreshReview()
  }, [reviewGenerating, onRefreshReview])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-[14px] text-sm transition-colors',
            isActive
              ? 'border-indigo-200/70 bg-indigo-50/70 text-indigo-500 hover:bg-indigo-100/80 hover:text-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-400 dark:hover:bg-indigo-950/70'
              : 'bg-muted/60 text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground',
            reviewGenerating && 'animate-[ai-glow_2s_ease-in-out_infinite]',
          )}
          aria-label="AI settings"
        >
          {isActive && (
            <>
              <svg className="absolute size-0" aria-hidden="true">
                <defs>
                  <linearGradient id="ai-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#818cf8" />
                    <stop offset="100%" stopColor="#a78bfa" />
                  </linearGradient>
                </defs>
              </svg>
              <Sparkles className="size-5" style={{ stroke: 'url(#ai-gradient)' }} />
            </>
          )}
          <span>{isActive ? 'AI' : 'AI Off'}</span>
          <ChevronDown className="size-3.5 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="start">
        {/* Master on/off switch */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">AI</span>
          <Switch
            checked={mode === 'on'}
            onCheckedChange={(checked) => onModeChange(checked ? 'on' : 'off')}
          />
        </div>

        {/* Bubble section (blue accent) */}
        <div className="mt-4">
          <SectionHeader
            label="Bubble"
            freshnessText={annotationFreshnessText}
            generatedAt={annotationGeneratedAt}
            refreshing={annotationRefreshLoading}
            onRefresh={handleRefreshAnnotations}
            active={isActive}
            color="blue"
          />
          <div className="mt-1.5">
            <FeatureCheckbox
              label="Task annotations"
              description="Short AI notes on each task"
              checked={showBubbleText}
              onChange={onShowBubbleTextChange}
              disabled={!isActive}
              color="blue"
            />
          </div>
          {isActive && annotationError && (
            <p className="mt-1.5 text-[11px] text-red-500">{annotationError}</p>
          )}
        </div>

        {/* Divider */}
        <div className="my-3 border-t" />

        {/* Insights section (indigo accent) */}
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'text-xs font-semibold',
                  isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-muted-foreground',
                )}
              >
                Insights
              </span>
              {isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onShowInsightsChange(!showInsights)
                  }}
                  className={cn(
                    'rounded-full p-0.5 transition-colors',
                    showInsights
                      ? 'text-muted-foreground hover:text-foreground'
                      : 'text-muted-foreground/40 hover:text-muted-foreground',
                  )}
                  aria-label={showInsights ? 'Hide insights' : 'Show insights'}
                >
                  {showInsights ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                </button>
              )}
            </div>
            {isActive && showInsights && (
              <div className="flex items-center gap-1.5">
                {!reviewGenerating && reviewFreshnessText && (
                  <FreshnessWithTooltip
                    freshnessText={reviewFreshnessText}
                    generatedAt={reviewGeneratedAt}
                  />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRefreshReview()
                  }}
                  disabled={reviewGenerating}
                  className="text-muted-foreground hover:text-foreground rounded-full p-0.5 transition-colors disabled:opacity-40"
                  aria-label="Refresh insights"
                >
                  <RefreshCw className={cn('size-3', reviewGenerating && 'animate-spin')} />
                </button>
              </div>
            )}
          </div>

          {/* Checkboxes always visible when AI is on (disabled when insights eye is off) */}
          {isActive && (
            <div className="mt-1.5 space-y-2.5">
              <FeatureCheckbox
                label="Attention scores"
                description="Priority scores from 0–100"
                checked={showScores}
                onChange={onShowScoresChange}
                disabled={!showInsights}
                color="indigo"
              />
              <FeatureCheckbox
                label="Signal tags"
                description="Stale, Quick Win, Review, etc."
                checked={showSignals}
                onChange={onShowSignalsChange}
                disabled={!showInsights}
                color="indigo"
              />
              <FeatureCheckbox
                label="Commentary"
                description="Detailed per-task analysis"
                checked={showCommentary}
                onChange={onShowCommentaryChange}
                disabled={!showInsights}
                color="indigo"
              />
            </div>
          )}

          {isActive && showInsights && reviewError && !reviewGenerating && (
            <p className="mt-1.5 text-[11px] text-red-500">{reviewError}</p>
          )}

          {/* Progress bar — visible even when insights eye is off since generation is in progress */}
          {isActive && reviewGenerating && (
            <div className="mt-3">
              {reviewSingleCall ? (
                <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                  <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-indigo-400" />
                </div>
              ) : (
                <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full bg-indigo-400 transition-all duration-500"
                    style={{ width: `${reviewProgress}%` }}
                  />
                </div>
              )}
              <p className="text-muted-foreground mt-1 text-[11px]">
                Analyzing {reviewCompletedTasks}/{reviewTotalTasks} tasks... <ElapsedTimer />
              </p>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Format an ISO timestamp as a readable absolute time in the user's local timezone. */
function formatAbsoluteTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Section header: label + freshness (with tooltip) + refresh button */
function SectionHeader({
  label,
  freshnessText,
  generatedAt,
  refreshing,
  onRefresh,
  active,
  color,
}: {
  label: string
  freshnessText: string | null
  generatedAt: string | null
  refreshing: boolean
  onRefresh: () => void
  active: boolean
  color?: 'blue' | 'indigo'
}) {
  const colorClass =
    color === 'blue'
      ? 'text-blue-600 dark:text-blue-400'
      : color === 'indigo'
        ? 'text-indigo-600 dark:text-indigo-400'
        : ''

  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          'text-xs font-semibold',
          active && colorClass,
          !active && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      {active && (
        <div className="flex items-center gap-1.5">
          {freshnessText && (
            <FreshnessWithTooltip freshnessText={freshnessText} generatedAt={generatedAt} />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRefresh()
            }}
            disabled={refreshing}
            className="text-muted-foreground hover:text-foreground rounded-full p-0.5 transition-colors disabled:opacity-40"
            aria-label={`Refresh ${label.toLowerCase()}`}
          >
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Freshness text with absolute-time tooltip.
 * Desktop: hover shows tooltip. Mobile: tap toggles to absolute time briefly.
 */
function FreshnessWithTooltip({
  freshnessText,
  generatedAt,
}: {
  freshnessText: string
  generatedAt: string | null
}) {
  const [showAbsolute, setShowAbsolute] = useState(false)
  const absoluteTime = generatedAt ? formatAbsoluteTime(generatedAt) : null

  if (!absoluteTime) {
    return <span className="text-muted-foreground text-[11px]">{freshnessText}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground cursor-default text-[11px]"
          onClick={(e) => {
            // Mobile: toggle to absolute time on tap, revert after 2s
            e.stopPropagation()
            setShowAbsolute(true)
            setTimeout(() => setShowAbsolute(false), 2000)
          }}
        >
          {showAbsolute ? absoluteTime : freshnessText}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {absoluteTime}
      </TooltipContent>
    </Tooltip>
  )
}

function FeatureCheckbox({
  label,
  description,
  checked,
  onChange,
  disabled,
  color,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled: boolean
  color?: 'blue' | 'indigo'
}) {
  const checkedColorClass =
    color === 'blue'
      ? 'data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500'
      : color === 'indigo'
        ? 'data-[state=checked]:bg-indigo-500 data-[state=checked]:border-indigo-500'
        : ''

  return (
    <label
      className={cn(
        'flex items-start gap-2.5',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(val) => onChange(val === true)}
        className={cn('mt-0.5 size-3.5', checkedColorClass)}
        disabled={disabled}
      />
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="text-muted-foreground text-[11px] leading-tight">{description}</div>
      </div>
    </label>
  )
}

/** Live elapsed timer that counts up from mount. Resets when unmounted (i.e. generation stops). */
function ElapsedTimer() {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins === 0) return <span>{secs}s</span>
  return (
    <span>
      {mins}m {secs.toString().padStart(2, '0')}s
    </span>
  )
}
