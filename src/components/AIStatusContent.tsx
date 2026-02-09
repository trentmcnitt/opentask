'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AIActivityEntry } from '@/core/ai/types'

interface SlotStats {
  state: string
  activatedAt: string | null
  totalRequests: number
  totalRecycles: number
  lastRequestAt: string | null
  model: string
}

interface QueueStats {
  active: number
  waiting: number
  max: number
}

export interface AIStatusData {
  enrichment_slot: SlotStats
  queue: QueueStats
  recent_activity: AIActivityEntry[]
}

const ACTION_LABELS: Record<string, string> = {
  enrich: 'Enrichment',
  bubble: 'Bubble',
  briefing: 'Briefing',
  triage: 'Triage',
  shopping_label: 'Shopping',
  whats_next: "What's Next",
}

const ACTION_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'enrich', label: 'Enrichment' },
  { value: 'bubble', label: 'Bubble' },
  { value: 'briefing', label: 'Briefing' },
  { value: 'triage', label: 'Triage' },
  { value: 'shopping_label', label: 'Shopping' },
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
      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Enrichment Slot</h3>
          <Button variant="ghost" size="sm" onClick={onRefresh} className="text-xs">
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-zinc-500">State</span>
            <div className="mt-0.5">
              <SlotStateBadge state={data.enrichment_slot.state} />
            </div>
          </div>
          <div>
            <span className="text-zinc-500">Model</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.model}</p>
          </div>
          <div>
            <span className="text-zinc-500">Requests</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.totalRequests}</p>
          </div>
          <div>
            <span className="text-zinc-500">Recycles</span>
            <p className="mt-0.5 font-medium">{data.enrichment_slot.totalRecycles}</p>
          </div>
          {data.enrichment_slot.activatedAt && (
            <div className="col-span-2">
              <span className="text-zinc-500">Up since</span>
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

      {/* Queue status */}
      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h3 className="mb-3 text-sm font-semibold">Queue</h3>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-zinc-500">Active</span>
            <p className="mt-0.5 font-medium">{data.queue.active}</p>
          </div>
          <div>
            <span className="text-zinc-500">Waiting</span>
            <p className="mt-0.5 font-medium">{data.queue.waiting}</p>
          </div>
          <div>
            <span className="text-zinc-500">Max</span>
            <p className="mt-0.5 font-medium">{data.queue.max}</p>
          </div>
        </div>
      </div>

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
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700',
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
          <p className="py-4 text-center text-zinc-400">No AI activity recorded.</p>
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

function SlotStateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    available: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    busy: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
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
        : 'text-zinc-400'

  const hasDetails = !!(entry.input || entry.output || entry.error || entry.model)

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Collapsed header */}
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-3 p-3 text-left',
          hasDetails && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
        )}
        disabled={!hasDetails}
        type="button"
      >
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="size-4 flex-shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight className="size-4 flex-shrink-0 text-zinc-400" />
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
              <span className="text-xs text-zinc-400">{entry.duration_ms}ms</span>
            )}
          </div>
          {entry.input && <p className="mt-0.5 truncate text-xs text-zinc-500">{entry.input}</p>}
        </div>
        <span className="flex-shrink-0 text-xs text-zinc-400">
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
        <div className="space-y-3 border-t border-zinc-100 p-3 text-xs dark:border-zinc-800">
          {entry.model && (
            <div>
              <span className="font-medium text-zinc-500">Model</span>
              <p className="mt-0.5 font-mono text-zinc-700 dark:text-zinc-300">{entry.model}</p>
            </div>
          )}

          {entry.task_id && (
            <div>
              <span className="font-medium text-zinc-500">Task</span>
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
              <span className="font-medium text-zinc-500">Duration</span>
              <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">
                {entry.duration_ms}ms
                {entry.duration_ms >= 1000 && ` (${(entry.duration_ms / 1000).toFixed(1)}s)`}
              </p>
            </div>
          )}

          {entry.input && (
            <div>
              <span className="font-medium text-zinc-500">Input</span>
              <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-zinc-100 p-2 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {entry.input}
              </pre>
            </div>
          )}

          {entry.output && (
            <div>
              <span className="font-medium text-zinc-500">Output</span>
              <AIOutputDisplay output={entry.output} />
            </div>
          )}

          {entry.error && (
            <div>
              <span className="font-medium text-red-500">Error</span>
              <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-red-50 p-2 whitespace-pre-wrap text-red-700 dark:bg-red-900/20 dark:text-red-400">
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
      <div className="mt-0.5 space-y-1 rounded bg-zinc-100 p-2 dark:bg-zinc-800">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <span className="flex-shrink-0 font-medium text-zinc-500">{key}:</span>
            <span className="text-zinc-700 dark:text-zinc-300">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-zinc-100 p-2 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {output}
    </pre>
  )
}

/**
 * Small colored dot for AI status display in menus/headers.
 * Green = available/busy, Yellow = initializing, Red = dead/uninitialized, Gray = unknown fallback.
 */
export function AIStatusDot({ state }: { state: string | null }) {
  if (state === null) return null

  const color =
    state === 'available' || state === 'busy'
      ? 'bg-green-500'
      : state === 'initializing'
        ? 'bg-yellow-500'
        : state === 'dead' || state === 'uninitialized'
          ? 'bg-red-500'
          : 'bg-zinc-400'

  return <span className={cn('ml-auto inline-block size-2 rounded-full', color)} />
}
