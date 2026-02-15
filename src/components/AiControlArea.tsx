'use client'

import { useCallback, useEffect, useState } from 'react'
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
  // What's Next preferences
  wnCommentaryUnfiltered: boolean
  onWnCommentaryUnfilteredChange: (show: boolean) => void
  wnHighlight: boolean
  onWnHighlightChange: (show: boolean) => void
  // Insights preferences (when Insights chip is off)
  insightsSignalChips: boolean
  onInsightsSignalChipsChange: (show: boolean) => void
  insightsScoreChips: boolean
  onInsightsScoreChipsChange: (show: boolean) => void
  // What's Next status
  annotationGeneratedAt: string | null
  annotationDurationMs: number | null
  annotationFreshnessText: string | null
  annotationRefreshLoading: boolean
  annotationError: string | null
  onRefreshAnnotations: () => void
  // Insights status
  insightsGeneratedAt: string | null
  insightsDurationMs: number | null
  insightsGenerating: boolean
  insightsProgress: number
  insightsCompletedTasks: number
  insightsTotalTasks: number
  insightsSingleCall: boolean
  insightsGenerationStartedAt: string | null
  insightsError: string | null
  onRefreshInsights: () => void
}

/**
 * AI chip + popover — sits inline next to the QuickAdd input.
 *
 * The chip is a compact pill that opens a popover for configuration.
 * Two AI systems (What's Next and Insights) are clearly separated in the
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
  wnCommentaryUnfiltered,
  onWnCommentaryUnfilteredChange,
  wnHighlight,
  onWnHighlightChange,
  insightsSignalChips,
  onInsightsSignalChipsChange,
  insightsScoreChips,
  onInsightsScoreChipsChange,
  annotationGeneratedAt,
  annotationDurationMs,
  annotationFreshnessText,
  annotationRefreshLoading,
  annotationError,
  onRefreshAnnotations,
  insightsGeneratedAt,
  insightsDurationMs,
  insightsGenerating,
  insightsProgress,
  insightsCompletedTasks,
  insightsTotalTasks,
  insightsSingleCall,
  insightsGenerationStartedAt,
  insightsError,
  onRefreshInsights,
}: AiControlAreaProps) {
  const isActive = mode !== 'off'

  const insightsFreshnessText = insightsGeneratedAt ? formatRelativeTime(insightsGeneratedAt) : null

  const handleRefreshAnnotations = useCallback(() => {
    if (!annotationRefreshLoading) onRefreshAnnotations()
  }, [annotationRefreshLoading, onRefreshAnnotations])

  const handleRefreshInsights = useCallback(() => {
    if (!insightsGenerating) onRefreshInsights()
  }, [insightsGenerating, onRefreshInsights])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-[14px] text-sm transition-colors',
            isActive
              ? 'border-indigo-200/70 bg-indigo-50/70 text-indigo-500 hover:bg-indigo-100/80 hover:text-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-400 dark:hover:bg-indigo-950/70'
              : 'bg-muted/60 text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground',
            (insightsGenerating || annotationRefreshLoading) &&
              'animate-[ai-glow_2s_ease-in-out_infinite]',
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

        {/* What's Next section (blue accent) */}
        <div className="mt-4">
          <SectionHeader
            label="What's Next"
            freshnessText={annotationFreshnessText}
            generatedAt={annotationGeneratedAt}
            durationMs={annotationDurationMs}
            refreshing={annotationRefreshLoading}
            onRefresh={handleRefreshAnnotations}
            active={isActive}
            color="blue"
          />
          {isActive && (
            <div className="mt-1.5 space-y-2.5">
              <FeatureCheckbox
                label="Show commentary when not filtering"
                description="Display annotations on all What's Next tasks"
                checked={wnCommentaryUnfiltered}
                onChange={onWnCommentaryUnfilteredChange}
                disabled={false}
                color="blue"
              />
              <FeatureCheckbox
                label="Show background highlight"
                description="Subtle color on What's Next tasks"
                checked={wnHighlight}
                onChange={onWnHighlightChange}
                disabled={false}
                color="blue"
              />
            </div>
          )}
          {isActive && annotationRefreshLoading && (
            <div className="mt-2">
              <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-blue-400" />
              </div>
              <p className="text-muted-foreground mt-1 text-[11px]">
                Refreshing… <ElapsedTimer />
              </p>
              <p className="text-muted-foreground/60 mt-0.5 text-[11px]">
                Should take less than a minute.
              </p>
            </div>
          )}
          {isActive && annotationError && (
            <p className="mt-1.5 text-[11px] text-red-500">{annotationError}</p>
          )}
        </div>

        {/* Divider */}
        <div className="my-3 border-t" />

        {/* Insights section (indigo accent) — settings + refresh only */}
        <div>
          <SectionHeader
            label="Insights"
            freshnessText={insightsFreshnessText}
            generatedAt={insightsGeneratedAt}
            durationMs={insightsDurationMs}
            refreshing={insightsGenerating}
            onRefresh={handleRefreshInsights}
            active={isActive}
            color="indigo"
          />

          {/* Preferences for what shows in the FilterBar when Insights chip is off */}
          {isActive && (
            <div className="mt-2">
              <p className="text-muted-foreground mb-1.5 text-[11px]">
                When Insights is off, show:
              </p>
              <div className="space-y-2.5">
                <FeatureCheckbox
                  label="Signal counts"
                  description="Stale, Quick Win, Review chips"
                  checked={insightsSignalChips}
                  onChange={onInsightsSignalChipsChange}
                  disabled={false}
                  color="indigo"
                />
                <FeatureCheckbox
                  label="Score ranges"
                  description="Attention score filter chips"
                  checked={insightsScoreChips}
                  onChange={onInsightsScoreChipsChange}
                  disabled={false}
                  color="indigo"
                />
              </div>
            </div>
          )}

          {isActive && insightsError && !insightsGenerating && (
            <p className="mt-1.5 text-[11px] text-red-500">{insightsError}</p>
          )}

          {/* Progress bar — visible during generation */}
          {isActive && insightsGenerating && (
            <div className="mt-3">
              {insightsSingleCall ? (
                <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                  <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-indigo-400" />
                </div>
              ) : (
                <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full bg-indigo-400 transition-all duration-500"
                    style={{ width: `${insightsProgress}%` }}
                  />
                </div>
              )}
              <p className="text-muted-foreground mt-1 text-[11px]">
                Analyzing {insightsCompletedTasks}/{insightsTotalTasks} tasks…{' '}
                <ElapsedTimer startedAt={insightsGenerationStartedAt} />
              </p>
              <p className="text-muted-foreground/60 mt-0.5 text-[11px]">
                This may take several minutes.
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
  durationMs,
  refreshing,
  onRefresh,
  active,
  color,
}: {
  label: string
  freshnessText: string | null
  generatedAt: string | null
  durationMs?: number | null
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
          {freshnessText ? (
            <FreshnessWithTooltip
              freshnessText={freshnessText}
              generatedAt={generatedAt}
              durationMs={durationMs}
            />
          ) : (
            <span className="text-muted-foreground/50 text-[11px]">Not generated</span>
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

/** Format a duration in ms as a human-readable string (e.g. "took 47s", "took 2m 15s") */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `took ${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return secs > 0 ? `took ${mins}m ${secs}s` : `took ${mins}m`
}

/**
 * Freshness text with absolute-time tooltip.
 * Desktop: hover shows tooltip. Mobile: tap opens/closes tooltip.
 * Uses controlled open state so click works on touch devices
 * (Radix Tooltip is hover-only by default).
 */
function FreshnessWithTooltip({
  freshnessText,
  generatedAt,
  durationMs,
}: {
  freshnessText: string
  generatedAt: string | null
  durationMs?: number | null
}) {
  const [open, setOpen] = useState(false)
  const absoluteTime = generatedAt ? formatAbsoluteTime(generatedAt) : null

  if (!absoluteTime) {
    return <span className="text-muted-foreground text-[11px] select-none">{freshnessText}</span>
  }

  const tooltipText = durationMs ? `${absoluteTime} (${formatDuration(durationMs)})` : absoluteTime

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground cursor-default text-[11px] select-none"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((prev) => !prev)
          }}
        >
          {freshnessText}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltipText}
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

/**
 * Live elapsed timer that counts up from a start time.
 * When `startedAt` is provided (ISO string), calculates elapsed from that timestamp
 * so the timer survives page refreshes. Falls back to counting from mount time.
 */
function ElapsedTimer({ startedAt }: { startedAt?: string | null }) {
  const [seconds, setSeconds] = useState(() => {
    if (!startedAt) return 0
    return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  })

  useEffect(() => {
    const startMs = startedAt ? new Date(startedAt).getTime() : null
    const id = setInterval(() => {
      if (startMs !== null) {
        setSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)))
      } else {
        setSeconds((s) => s + 1)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [startedAt])

  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins === 0) return <span>{secs}s</span>
  return (
    <span>
      {mins}m {secs.toString().padStart(2, '0')}s
    </span>
  )
}
