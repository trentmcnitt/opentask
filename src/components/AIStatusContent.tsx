'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AIActivityEntry } from '@/core/ai/types'
import type { EnrichmentSlotStats, QuickTakeSlotStats } from '@/core/ai'

interface QueueStats {
  active: number
  waiting: number
  maxConcurrent: number
}

interface InProgressEnrichment {
  slot: {
    taskId: number | null
    inputText: string | null
    startedAt: string | null
  } | null
  pipeline_task_ids: number[]
  circuit_breaker_open: boolean
  pending_count: number
}

interface InProgressInsights {
  session_id: string
  status: string
  total_tasks: number
  completed: number
  started_at: string
}

export interface AIStatusData {
  enrichment_slot: EnrichmentSlotStats
  quick_take_slot: QuickTakeSlotStats
  queue: QueueStats
  in_progress: {
    enrichment: InProgressEnrichment
    insights: InProgressInsights | null
  }
  recent_activity: AIActivityEntry[]
}

const ACTION_LABELS: Record<string, string> = {
  enrich: 'Enrichment',
  quick_take: 'Quick Take',
  whats_next: "What's Next",
  insights: 'Insights',
}

const ACTION_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'enrich', label: 'Enrichment' },
  { value: 'quick_take', label: 'Quick Take' },
  { value: 'whats_next', label: "What's Next" },
  { value: 'insights', label: 'Insights' },
]

interface AIStatusContentProps {
  data: AIStatusData
  timezone: string
  onRefresh: () => void
  /** Whether to show filter chips and pagination controls */
  showFilters?: boolean
  /** Current action filter value */
  actionFilter?: string
  /** Callback when action filter changes */
  onActionFilterChange?: (action: string) => void
  /** Whether more activity entries are available */
  hasMore?: boolean
  /** Callback to load more activity entries */
  onLoadMore?: () => void
  /** Whether a load-more request is in progress */
  loadingMore?: boolean
}

export function AIStatusContent({
  data,
  timezone,
  onRefresh,
  showFilters = false,
  actionFilter = '',
  onActionFilterChange,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
}: AIStatusContentProps) {
  return (
    <div className="space-y-6">
      {/* Enrichment slot status */}
      <div className="border-border rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Enrichment Slot</h3>
          <Button variant="ghost" size="sm" onClick={onRefresh} className="text-xs">
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">State</span>
            <div className="mt-0.5">
              <SlotStateBadge state={data.enrichment_slot.state} />
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Model</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.model}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Requests</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.totalRequests}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Recycles</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.totalRecycles}</p>
          </div>
          {data.enrichment_slot.activatedAt && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Up since</span>
              <p className="mt-0.5 text-xs">
                {new Date(data.enrichment_slot.activatedAt).toLocaleString('en-US', {
                  timeZone: timezone,
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Take slot status */}
      <div className="border-border rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold">Quick Take Slot</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">State</span>
            <div className="mt-0.5">
              <SlotStateBadge state={data.quick_take_slot.state} />
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Model</span>
            <p className="mt-0.5 font-medium">{data.quick_take_slot.model}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Requests</span>
            <p className="mt-0.5 font-medium">{data.quick_take_slot.totalRequests}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Recycles</span>
            <p className="mt-0.5 font-medium">{data.quick_take_slot.totalRecycles}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Superseded</span>
            <p className="mt-0.5 font-medium">{data.quick_take_slot.totalSuperseded}</p>
          </div>
          {data.quick_take_slot.activatedAt && (
            <div>
              <span className="text-muted-foreground">Up since</span>
              <p className="mt-0.5 text-xs">
                {new Date(data.quick_take_slot.activatedAt).toLocaleString('en-US', {
                  timeZone: timezone,
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Queue status */}
      <div className="border-border rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold">Queue</h3>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">Active</span>
            <p className="mt-0.5 font-medium">{data.queue.active}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Waiting</span>
            <p className="mt-0.5 font-medium">{data.queue.waiting}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Max</span>
            <p className="mt-0.5 font-medium">{data.queue.maxConcurrent}</p>
          </div>
        </div>
      </div>

      {/* In-progress operations */}
      <InProgressSection data={data} />

      {/* Action filter chips */}
      {showFilters && onActionFilterChange && (
        <div className="flex flex-wrap gap-1.5">
          {ACTION_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onActionFilterChange(opt.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                actionFilter === opt.value
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Recent AI activity */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">Recent Activity</h3>
        {data.recent_activity.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center">No AI activity recorded.</p>
        ) : (
          <div className="space-y-2">
            {data.recent_activity.map((entry) => (
              <ExpandableAIActivityRow key={entry.id} entry={entry} timezone={timezone} />
            ))}
          </div>
        )}

        {/* Load more button */}
        {hasMore && onLoadMore && (
          <div className="mt-4 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="text-xs"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Pulsing dot animation used for in-progress indicators. */
function PulsingDot({ color = 'bg-indigo-400' }: { color?: string }) {
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0">
      <span
        className={cn(
          'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
          color,
        )}
      />
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', color)} />
    </span>
  )
}

/** Live elapsed time counter since a given ISO timestamp (e.g., "12s", "2m 15s"). */
function ElapsedTime({ startedAt }: { startedAt: string }) {
  const [text, setText] = useState(() => formatElapsed(startedAt))

  useEffect(() => {
    const id = setInterval(() => setText(formatElapsed(startedAt)), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  return <span className="text-muted-foreground text-xs tabular-nums">{text}</span>
}

function formatElapsed(startedAt: string): string {
  const totalSec = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000))
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`
}

/**
 * In-progress section — shows active enrichment, quick take, and insights operations.
 * Only renders when there's something in progress.
 */
function InProgressSection({ data }: { data: AIStatusData }) {
  const { enrichment, insights } = data.in_progress
  const quickTakeOp = data.quick_take_slot.currentOperation
  const hasEnrichmentActivity =
    enrichment.slot || enrichment.pending_count > 0 || enrichment.circuit_breaker_open
  const hasActivity = hasEnrichmentActivity || insights || quickTakeOp

  if (!hasActivity) return null

  return (
    <div className="border-border rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">In Progress</h3>
      <div className="space-y-3 text-sm">
        {/* Enrichment slot currently processing */}
        {enrichment.slot && (
          <div className="flex items-center gap-2">
            <PulsingDot />
            <div className="min-w-0 flex-1">
              <span>
                Enriching
                {enrichment.slot.taskId && <> task #{enrichment.slot.taskId}</>}
              </span>
              {enrichment.slot.inputText && (
                <span className="text-muted-foreground">
                  {' '}
                  &mdash; &ldquo;
                  {enrichment.slot.inputText.length > 40
                    ? enrichment.slot.inputText.slice(0, 40) + '...'
                    : enrichment.slot.inputText}
                  &rdquo;
                </span>
              )}
            </div>
            {enrichment.slot.startedAt && <ElapsedTime startedAt={enrichment.slot.startedAt} />}
          </div>
        )}

        {/* Enrichment queue pending */}
        {enrichment.pending_count > 0 && (
          <div className="text-muted-foreground text-xs">
            {enrichment.slot
              ? `+${Math.max(0, enrichment.pending_count - 1)} more queued`
              : `${enrichment.pending_count} task${enrichment.pending_count !== 1 ? 's' : ''} queued for enrichment`}
          </div>
        )}

        {/* Circuit breaker warning */}
        {enrichment.circuit_breaker_open && (
          <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Enrichment paused (circuit breaker tripped)
          </div>
        )}

        {/* Quick take in progress */}
        {quickTakeOp && (
          <div className="flex items-center gap-2">
            <PulsingDot />
            <div className="min-w-0 flex-1">
              <span>Generating quick take</span>
              {quickTakeOp.inputText && (
                <span className="text-muted-foreground">
                  {' '}
                  &mdash; &ldquo;
                  {quickTakeOp.inputText.length > 40
                    ? quickTakeOp.inputText.slice(0, 40) + '...'
                    : quickTakeOp.inputText}
                  &rdquo;
                </span>
              )}
            </div>
            {quickTakeOp.startedAt && <ElapsedTime startedAt={quickTakeOp.startedAt} />}
          </div>
        )}

        {/* Active insights session */}
        {insights && (
          <div>
            <div className="flex items-center gap-2">
              <PulsingDot />
              <span className="flex-1">Deeply analyzing {insights.total_tasks} tasks</span>
              <ElapsedTime startedAt={insights.started_at} />
            </div>
            <div className="mt-2 ml-4">
              <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full bg-indigo-400 transition-all duration-500"
                  style={{
                    width: `${insights.total_tasks > 0 ? Math.round((insights.completed / insights.total_tasks) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SlotStateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    available: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    busy: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    initializing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    dead: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    uninitialized: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  }

  return <Badge className={cn('text-xs', styles[state] || styles.uninitialized)}>{state}</Badge>
}

/**
 * Expandable AI activity row.
 * Collapsed: action badge, status, duration, truncated input, timestamp.
 * Expanded: full input, output (parsed as JSON if possible), error, model, task link, duration.
 */
function ExpandableAIActivityRow({
  entry,
  timezone,
}: {
  entry: AIActivityEntry
  timezone: string
}) {
  const [expanded, setExpanded] = useState(false)

  const statusColor =
    entry.status === 'success'
      ? 'text-green-600 dark:text-green-400'
      : entry.status === 'error'
        ? 'text-red-600 dark:text-red-400'
        : 'text-muted-foreground'

  const hasDetails = !!(entry.input || entry.output || entry.error || entry.model)

  return (
    <div className="border-border rounded-lg border">
      {/* Collapsed header */}
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-3 p-3 text-left',
          hasDetails && 'hover:bg-muted/50 cursor-pointer',
        )}
        disabled={!hasDetails}
        type="button"
      >
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="text-muted-foreground size-4 flex-shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4 flex-shrink-0" />
          )
        ) : (
          <span className="size-4 flex-shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {ACTION_LABELS[entry.action] || entry.action}
            </Badge>
            <span className={cn('text-xs font-medium', statusColor)}>{entry.status}</span>
            {entry.duration_ms != null && (
              <span className="text-muted-foreground text-xs">{entry.duration_ms}ms</span>
            )}
          </div>
          {entry.input && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{entry.input}</p>
          )}
        </div>
        <span className="text-muted-foreground flex-shrink-0 text-xs">
          {entry.created_at
            ? new Date(entry.created_at).toLocaleString('en-US', {
                timeZone: timezone,
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })
            : ''}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="border-border space-y-3 border-t p-3 text-xs">
          {entry.model && (
            <div>
              <span className="text-muted-foreground font-medium">Model</span>
              <p className="text-foreground mt-0.5 font-mono">{entry.model}</p>
            </div>
          )}

          {entry.task_id && (
            <div>
              <span className="text-muted-foreground font-medium">Task</span>
              <p className="mt-0.5">
                <Link
                  href={`/tasks/${entry.task_id}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Task #{entry.task_id}
                </Link>
              </p>
            </div>
          )}

          {entry.duration_ms != null && (
            <div>
              <span className="text-muted-foreground font-medium">Duration</span>
              <p className="text-foreground mt-0.5">
                {entry.duration_ms}ms
                {entry.duration_ms >= 1000 && ` (${(entry.duration_ms / 1000).toFixed(1)}s)`}
              </p>
            </div>
          )}

          {entry.input && (
            <div>
              <span className="text-muted-foreground font-medium">Input</span>
              <pre className="bg-muted text-foreground mt-0.5 max-h-40 cursor-text overflow-auto rounded p-2 whitespace-pre-wrap select-text">
                {entry.input}
              </pre>
            </div>
          )}

          {entry.output && (
            <div>
              <span className="text-muted-foreground font-medium">Output</span>
              <AIOutputDisplay output={entry.output} />
            </div>
          )}

          {entry.error && (
            <div>
              <span className="font-medium text-red-500">Error</span>
              <pre className="mt-0.5 max-h-40 cursor-text overflow-auto rounded bg-red-50 p-2 whitespace-pre-wrap text-red-700 select-text dark:bg-red-900/20 dark:text-red-400">
                {entry.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Try to parse a string as JSON and return entries if it's an object.
 * Returns null if the string is not valid JSON or not an object.
 */
function parseJsonEntries(text: string): [string, unknown][] | null {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.entries(parsed)
    }
  } catch {
    // Not valid JSON
  }
  return null
}

/**
 * Renders AI output, parsing JSON if possible to show structured key-value pairs.
 */
function AIOutputDisplay({ output }: { output: string }) {
  const entries = parseJsonEntries(output)

  if (entries) {
    return (
      <div className="bg-muted mt-0.5 cursor-text space-y-1 rounded p-2 select-text">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <span className="text-muted-foreground flex-shrink-0 font-medium">{key}:</span>
            <span className="text-foreground">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <pre className="bg-muted text-foreground mt-0.5 max-h-40 cursor-text overflow-auto rounded p-2 whitespace-pre-wrap select-text">
      {output}
    </pre>
  )
}

/**
 * Small colored dot for AI status display in menus/headers.
 * Green = available, pulsing purple = busy, Yellow = initializing,
 * Red = dead/uninitialized, Gray = unknown fallback.
 */
export function AIStatusDot({ state, className }: { state: string | null; className?: string }) {
  if (state === null) return null

  const color =
    state === 'available'
      ? 'bg-green-500'
      : state === 'busy'
        ? 'bg-indigo-500'
        : state === 'initializing'
          ? 'bg-yellow-500'
          : state === 'dead' || state === 'uninitialized'
            ? 'bg-red-500'
            : 'bg-muted-foreground'

  if (state === 'busy') {
    return (
      <span className={cn('relative inline-flex size-2', className)}>
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
            color,
          )}
        />
        <span className={cn('relative inline-flex size-2 rounded-full', color)} />
      </span>
    )
  }

  return <span className={cn('inline-block size-2 rounded-full', color, className)} />
}
