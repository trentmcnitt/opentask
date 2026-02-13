'use client'

import { useCallback, useState } from 'react'
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react'
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

        {/* Bubble section */}
        <div className="mt-4">
          <SectionHeader
            label="Bubble"
            freshnessText={annotationFreshnessText}
            generatedAt={annotationGeneratedAt}
            refreshing={annotationRefreshLoading}
            onRefresh={handleRefreshAnnotations}
            active={isActive}
          />
          <div className="mt-1.5">
            <FeatureCheckbox
              label="Task annotations"
              description="Short AI notes on each task"
              checked={showBubbleText}
              onChange={onShowBubbleTextChange}
              disabled={!isActive}
            />
          </div>
          {isActive && annotationError && (
            <p className="mt-1.5 text-[11px] text-red-500">{annotationError}</p>
          )}
        </div>

        {/* Divider */}
        <div className="my-3 border-t" />

        {/* Insights section */}
        <div>
          <SectionHeader
            label="Insights"
            freshnessText={reviewGenerating ? null : reviewFreshnessText}
            generatedAt={reviewGenerating ? null : reviewGeneratedAt}
            refreshing={reviewGenerating}
            onRefresh={handleRefreshReview}
            active={isActive}
          />
          <div className="mt-1.5 space-y-2.5">
            <FeatureCheckbox
              label="Attention scores"
              description="Priority scores from 0–100"
              checked={showScores}
              onChange={onShowScoresChange}
              disabled={!isActive}
            />
            <FeatureCheckbox
              label="Signal tags"
              description="Stale, Quick Win, Review, etc."
              checked={showSignals}
              onChange={onShowSignalsChange}
              disabled={!isActive}
            />
            <FeatureCheckbox
              label="Commentary"
              description="Detailed per-task analysis"
              checked={showCommentary}
              onChange={onShowCommentaryChange}
              disabled={!isActive}
            />
          </div>

          {isActive && reviewError && !reviewGenerating && (
            <p className="mt-1.5 text-[11px] text-red-500">{reviewError}</p>
          )}

          {/* Progress bar (inside popover during insights generation) */}
          {reviewGenerating && (
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
                Analyzing {reviewCompletedTasks}/{reviewTotalTasks} tasks... This may take a few
                minutes.
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
}: {
  label: string
  freshnessText: string | null
  generatedAt: string | null
  refreshing: boolean
  onRefresh: () => void
  active: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn('text-xs font-semibold', !active && 'text-muted-foreground')}>
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
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled: boolean
}) {
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
        className="mt-0.5 size-3.5"
        disabled={disabled}
      />
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="text-muted-foreground text-[11px] leading-tight">{description}</div>
      </div>
    </label>
  )
}
