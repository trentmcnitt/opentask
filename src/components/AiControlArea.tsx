'use client'

import { useCallback } from 'react'
import { ChevronDown, RefreshCw, Sparkles } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
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
  annotationFreshnessText: string | null
  annotationRefreshLoading: boolean
  onRefreshAnnotations: () => void
  // Insights (Review)
  reviewGeneratedAt: string | null
  reviewGenerating: boolean
  onRefreshReview: () => void
}

/**
 * AI chip + popover — sits inline next to the QuickAdd input.
 *
 * The chip is a compact pill that opens a popover for configuration.
 * Two AI systems (Bubble and Insights) are clearly separated in the
 * popover with their own freshness timestamps and refresh buttons.
 *
 * The progress bar for insights generation is rendered separately in
 * page.tsx (between this row and the filter bar) so it can span full width.
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
  annotationFreshnessText,
  annotationRefreshLoading,
  onRefreshAnnotations,
  reviewGeneratedAt,
  reviewGenerating,
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
            'flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors',
            isActive
              ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
          )}
          aria-label="AI settings"
        >
          {isActive && (
            <>
              <svg className="absolute size-0" aria-hidden="true">
                <defs>
                  <linearGradient id="ai-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
              </svg>
              <Sparkles className="size-4" style={{ stroke: 'url(#ai-gradient)' }} />
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
        </div>

        {/* Divider */}
        <div className="my-3 border-t" />

        {/* Insights section */}
        <div>
          <SectionHeader
            label="Insights"
            freshnessText={reviewGenerating ? 'Analyzing...' : reviewFreshnessText}
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
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Section header: label + freshness + refresh (only when AI is active) */
function SectionHeader({
  label,
  freshnessText,
  refreshing,
  onRefresh,
  active,
}: {
  label: string
  freshnessText: string | null
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
            <span
              className={cn(
                'text-[11px]',
                refreshing ? 'animate-pulse text-indigo-500' : 'text-muted-foreground',
              )}
            >
              {freshnessText}
            </span>
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
