'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Undo2, Redo2 } from 'lucide-react'
import {
  formatDurationDelta,
  formatTimeInTimezone,
  getTimezoneDayBoundaries,
} from '@/lib/format-date'
import { FIELD_LABELS, truncateTitle } from '@/lib/field-labels'
import { getPriorityOption } from '@/lib/priority'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BatchUndoDialog } from '@/components/BatchUndoDialog'
import { showToast } from '@/lib/toast'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { AIStatusContent, type AIStatusData } from '@/components/AIStatusContent'
import type { Task, UndoAction } from '@/types'

interface CompletionEntry {
  id: number
  task_id: number
  task_title: string
  completed_at: string
  due_at_was: string | null
}

interface UndoSnapshot {
  task_id: number
  before_state: Partial<Task>
  after_state: Partial<Task>
  completion_id?: number
}

interface UndoEntry {
  id: number
  action: UndoAction
  description: string | null
  created_at: string
  undone: boolean
  fields_changed: string[]
  snapshot: UndoSnapshot[]
}

type TabId = 'completions' | 'activity' | 'ai'

export default function HistoryPage() {
  const { status } = useSession()
  const router = useRouter()
  const timezone = useTimezone()
  const [tab, setTab] = useState<TabId>('activity')
  const [completions, setCompletions] = useState<CompletionEntry[]>([])
  const [activities, setActivities] = useState<UndoEntry[]>([])

  // Read tab from URL on mount (avoids useSearchParams which requires Suspense boundary)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('tab')
    if (t === 'activity' || t === 'completions' || t === 'ai') setTab(t)
  }, [])

  const handleTabChange = useCallback((newTab: TabId) => {
    setTab(newTab)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', newTab)
    window.history.replaceState({}, '', url.toString())
  }, [])
  const [activityFetchedAt, setActivityFetchedAt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])

  const fetchActivity = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/undo/history?limit=50')
      if (res.ok) {
        const data = await res.json()
        setActivities(data.data?.history || [])
        setActivityFetchedAt(Date.now())
      }
    } catch {
      // Handled silently
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }

    async function fetchData() {
      setLoading(true)
      try {
        if (tab === 'completions') {
          const res = await fetch(`/api/completions?date=${date}`)
          if (res.ok) {
            const data = await res.json()
            setCompletions(data.data?.completions || [])
          }
        } else {
          await fetchActivity()
          return // fetchActivity already handles setLoading
        }
      } catch {
        // Handled silently
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [status, router, tab, date, fetchActivity])

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">History</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {/* Tab bar */}
        <div className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
          <button
            onClick={() => handleTabChange('activity')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'activity'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Activity
          </button>
          <button
            onClick={() => handleTabChange('completions')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'completions'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Completions
          </button>
          <button
            onClick={() => handleTabChange('ai')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'ai'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            AI
          </button>
        </div>

        {tab === 'completions' && (
          <CompletionsTab
            date={date}
            setDate={setDate}
            loading={loading}
            completions={completions}
            timezone={timezone}
          />
        )}

        {tab === 'activity' && (
          <ActivityTab
            loading={loading}
            activities={activities}
            timezone={timezone}
            onRefresh={fetchActivity}
            now={activityFetchedAt}
          />
        )}

        {tab === 'ai' && <AITab timezone={timezone} />}
      </main>
    </div>
  )
}

function CompletionsTab({
  date,
  setDate,
  loading,
  completions,
  timezone,
}: {
  date: string
  setDate: (d: string) => void
  loading: boolean
  completions: CompletionEntry[]
  timezone: string
}) {
  return (
    <div>
      {/* Date navigation */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => {
            const d = new Date(date)
            d.setDate(d.getDate() - 1)
            setDate(d.toISOString().split('T')[0])
          }}
          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Previous day"
        >
          &larr;
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
        <button
          onClick={() => {
            const d = new Date(date)
            d.setDate(d.getDate() + 1)
            setDate(d.toISOString().split('T')[0])
          }}
          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Next day"
        >
          &rarr;
        </button>
      </div>

      {loading ? (
        <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
      ) : completions.length === 0 ? (
        <p className="py-8 text-center text-zinc-400">No completions for this date.</p>
      ) : (
        <div className="space-y-2">
          {completions.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <span className="text-green-500">&#x2713;</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.task_title}</p>
                <p className="text-xs text-zinc-400">
                  {new Date(c.completed_at).toLocaleTimeString('en-US', {
                    timeZone: timezone,
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Format priority value as human-readable string.
 */
function formatPriority(value: number | undefined): string {
  return getPriorityOption(value ?? 0).label
}

/**
 * Format a rich activity description based on action type and snapshot data.
 */
function formatActivityDescription(entry: UndoEntry, timezone: string): string {
  const { action, snapshot, fields_changed } = entry

  // Get task title from snapshot (prefer before_state, fall back to after_state)
  const firstSnapshot = snapshot[0]
  const taskTitle =
    firstSnapshot?.before_state?.title || firstSnapshot?.after_state?.title || 'task'
  const truncatedTitle = truncateTitle(taskTitle, 30)

  // For bulk operations, show count
  const isBulk = action.startsWith('bulk_')
  const taskCount = snapshot.length

  switch (action) {
    case 'done':
    case 'bulk_done':
      if (isBulk) {
        return `Completed ${taskCount} tasks`
      }
      return `Completed '${truncatedTitle}'`

    case 'undone':
      return `Marked '${truncatedTitle}' incomplete`

    case 'snooze':
    case 'bulk_snooze': {
      if (isBulk) {
        // For bulk snooze, show the delta from first task
        const beforeDue = firstSnapshot?.before_state?.due_at
        const afterDue = firstSnapshot?.after_state?.due_at
        if (beforeDue && afterDue) {
          const delta = formatDurationDelta(
            new Date(beforeDue).getTime(),
            new Date(afterDue).getTime(),
          )
          return `Snoozed ${taskCount} tasks ${delta}`
        }
        return `Snoozed ${taskCount} tasks`
      }

      // Single snooze - show duration and time change
      const beforeDue = firstSnapshot?.before_state?.due_at
      const afterDue = firstSnapshot?.after_state?.due_at
      if (beforeDue && afterDue) {
        const delta = formatDurationDelta(
          new Date(beforeDue).getTime(),
          new Date(afterDue).getTime(),
        )
        const fromTime = formatTimeInTimezone(beforeDue, timezone)
        const toTime = formatTimeInTimezone(afterDue, timezone)
        return `Snoozed '${truncatedTitle}' ${delta} (${fromTime} → ${toTime})`
      }
      return `Snoozed '${truncatedTitle}'`
    }

    case 'edit':
    case 'bulk_edit': {
      if (isBulk) {
        // Show what fields were edited
        const fieldList = formatFieldList(fields_changed)
        return `Edited ${taskCount} tasks: ${fieldList}`
      }

      // Single edit - show field changes with values
      const details = formatEditDetails(firstSnapshot, fields_changed, timezone)
      if (details) {
        return `Edited '${truncatedTitle}': ${details}`
      }
      return `Edited '${truncatedTitle}'`
    }

    case 'create':
      return `Created '${truncatedTitle}'`

    case 'delete':
    case 'bulk_delete':
      if (isBulk) {
        return `Deleted ${taskCount} tasks`
      }
      return `Deleted '${truncatedTitle}'`

    case 'restore':
      return `Restored '${truncatedTitle}'`

    default:
      return entry.description || action
  }
}

/**
 * Format a list of field names for display.
 */
function formatFieldList(fields: string[]): string {
  const displayNames: Record<string, string> = { ...FIELD_LABELS, done: 'status' }

  return fields
    .map((f) => displayNames[f] || f)
    .slice(0, 3) // Limit to 3 fields
    .join(', ')
}

/**
 * Format edit details showing before/after values for changed fields.
 */
function formatEditDetails(
  snapshot: UndoSnapshot | undefined,
  fields: string[],
  timezone: string,
): string {
  if (!snapshot) return ''

  const { before_state, after_state } = snapshot
  const parts: string[] = []

  for (const field of fields) {
    switch (field) {
      case 'priority': {
        const before = formatPriority(before_state.priority)
        const after = formatPriority(after_state.priority)
        if (before !== after) {
          parts.push(`priority ${before}→${after}`)
        }
        break
      }
      case 'title': {
        const beforeTitle = before_state.title
        const afterTitle = after_state.title
        if (beforeTitle !== afterTitle && beforeTitle && afterTitle) {
          // Truncate titles for display
          const truncBefore = beforeTitle.length > 15 ? beforeTitle.slice(0, 15) + '…' : beforeTitle
          const truncAfter = afterTitle.length > 15 ? afterTitle.slice(0, 15) + '…' : afterTitle
          parts.push(`"${truncBefore}"→"${truncAfter}"`)
        }
        break
      }
      case 'due_at': {
        const beforeDue = before_state.due_at
        const afterDue = after_state.due_at
        if (beforeDue && afterDue) {
          const fromTime = formatTimeInTimezone(beforeDue, timezone)
          const toTime = formatTimeInTimezone(afterDue, timezone)
          parts.push(`due ${fromTime}→${toTime}`)
        } else if (!beforeDue && afterDue) {
          parts.push('added due date')
        } else if (beforeDue && !afterDue) {
          parts.push('removed due date')
        }
        break
      }
      case 'done': {
        if (before_state.done !== after_state.done) {
          parts.push(after_state.done ? 'completed' : 'incomplete')
        }
        break
      }
      case 'labels': {
        const beforeLabels = before_state.labels || []
        const afterLabels = after_state.labels || []
        const added = afterLabels.filter((l) => !beforeLabels.includes(l))
        const removed = beforeLabels.filter((l) => !afterLabels.includes(l))
        if (added.length > 0 && removed.length === 0) {
          parts.push(`+${added.join(', ')}`)
        } else if (removed.length > 0 && added.length === 0) {
          parts.push(`-${removed.join(', ')}`)
        } else if (added.length > 0 || removed.length > 0) {
          parts.push('labels')
        }
        break
      }
      case 'rrule': {
        const beforeRrule = before_state.rrule
        const afterRrule = after_state.rrule
        if (!beforeRrule && afterRrule) {
          parts.push('added recurrence')
        } else if (beforeRrule && !afterRrule) {
          parts.push('removed recurrence')
        } else {
          parts.push('changed recurrence')
        }
        break
      }
      // Skip internal fields that don't need display
      case 'anchor_time':
      case 'anchor_dow':
      case 'anchor_dom':
      case 'snoozed_from': // legacy field name
      case 'original_due_at': // current field name
      case 'updated_at':
        break
      default:
        // For unhandled fields, just show the name
        if (!field.startsWith('anchor_')) {
          parts.push(field.replace(/_/g, ' '))
        }
    }
  }

  return parts.slice(0, 3).join(', ') // Limit to 3 details
}

/**
 * Determines whether to show a separator pill between two adjacent entries.
 * Threshold adapts based on the age of the older entry (entries are newest-first):
 * - Last 24 hours: separator if gap > 5 minutes (fine granularity when it matters)
 * - 1–7 days ago: separator if gap > 2 hours (collapse rapid bursts)
 * - Beyond 1 week: separator if gap > 24 hours (day-level only)
 */
function shouldShowSeparator(prev: UndoEntry, current: UndoEntry, now: number): boolean {
  const prevTime = new Date(prev.created_at).getTime()
  const currentTime = new Date(current.created_at).getTime()
  const currentAge = now - currentTime
  const gap = prevTime - currentTime // positive: prev is newer (list is newest-first)

  const ONE_HOUR = 3_600_000
  const ONE_DAY = 86_400_000

  let threshold: number
  if (currentAge < ONE_HOUR) {
    threshold = 3 * 60_000 // 3 minutes
  } else if (currentAge < 2 * ONE_HOUR) {
    threshold = 15 * 60_000 // 15 minutes
  } else if (currentAge < ONE_DAY) {
    threshold = 30 * 60_000 // 30 minutes
  } else if (currentAge < 3 * ONE_DAY) {
    threshold = 3 * ONE_HOUR // 3 hours
  } else if (currentAge < 7 * ONE_DAY) {
    threshold = 6 * ONE_HOUR // 6 hours
  } else {
    threshold = ONE_DAY // 24 hours
  }

  return gap > threshold
}

/**
 * Format a label for the separator pill above an activity entry.
 * Uses precise timezone-aware day boundaries for "Yesterday" detection.
 *
 * Label tiers (most recent → oldest):
 * - < 1h:     "3:04 PM (54m ago)"
 * - 1–24h:    "12:48 PM (3h ago)"
 * - Yesterday: "Yesterday 12:33 PM"
 * - 2–4 days: "Wednesday 3:15 PM"   (weekday + time)
 * - 5–7 days: "Feb 3 3:15 PM"       (date + time)
 * - > 7 days: "Feb 3"               (date only)
 */
function formatTimeAgoLabel(entry: UndoEntry, now: number, timezone: string): string {
  const entryTime = new Date(entry.created_at).getTime()
  const entryDate = new Date(entry.created_at)
  const age = now - entryTime

  const ONE_HOUR = 3_600_000
  const ONE_DAY = 86_400_000

  const formatTime = () =>
    entryDate.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

  if (age < ONE_HOUR) {
    const minutes = Math.max(1, Math.floor(age / 60_000))
    return `${formatTime()} (${minutes}m ago)`
  }

  if (age < ONE_DAY) {
    const hours = Math.floor(age / ONE_HOUR)
    return `${formatTime()} (${hours}h ago)`
  }

  // Use precise day boundaries to detect "Yesterday" vs weekday
  const { todayStart } = getTimezoneDayBoundaries(timezone)
  const yesterdayStart = new Date(todayStart.getTime() - ONE_DAY)

  if (entryTime >= yesterdayStart.getTime() && entryTime < todayStart.getTime()) {
    return `Yesterday ${formatTime()}`
  }

  // 2–4 days ago: weekday + time
  const fourDaysAgo = new Date(todayStart.getTime() - 4 * ONE_DAY)
  if (entryTime >= fourDaysAgo.getTime()) {
    const weekday = entryDate.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'long',
    })
    return `${weekday} ${formatTime()}`
  }

  // 5–7 days ago: date + time
  if (age < 7 * ONE_DAY) {
    const date = entryDate.toLocaleDateString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
    })
    return `${date} ${formatTime()}`
  }

  // > 7 days: date only
  return entryDate.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  })
}

function ActivityTab({
  loading,
  activities,
  timezone,
  onRefresh,
  now,
}: {
  loading: boolean
  activities: UndoEntry[]
  timezone: string
  onRefresh: () => void
  /** Timestamp captured when activities were fetched — used for time-ago separator labels. */
  now: number
}) {
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [batchMode, setBatchMode] = useState<'undo' | 'redo'>('undo')
  const [batchCount, setBatchCount] = useState(0)
  const [batchThroughId, setBatchThroughId] = useState<number | null>(null)

  // --- Cmd+Z / Cmd+Shift+Z keyboard shortcuts for single undo/redo ---
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)
  const handleRedoRef = useRef<(() => Promise<void>) | null>(null)

  const handleUndo = useCallback(async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to undo' })
        return
      }
      const data = await res.json()
      onRefresh()
      showToast({
        message: `Undid: ${data.data.description}`,
        type: 'success',
        action: { label: 'Redo', onClick: () => handleRedoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Undo failed', type: 'error' })
    }
  }, [onRefresh])

  const handleRedo = useCallback(async () => {
    try {
      const res = await fetch('/api/redo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to redo' })
        return
      }
      const data = await res.json()
      onRefresh()
      showToast({
        message: `Redid: ${data.data.description}`,
        type: 'success',
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Redo failed', type: 'error' })
    }
  }, [onRefresh])

  useEffect(() => {
    handleUndoRef.current = handleUndo
    handleRedoRef.current = handleRedo
  }, [handleUndo, handleRedo])

  useUndoRedoShortcuts(handleUndoRef, handleRedoRef)

  const handleUndoToHere = useCallback(
    (entryId: number) => {
      // Count non-undone entries from the top down to (and including) this entry
      const count = activities.filter((a) => !a.undone && a.id >= entryId).length
      if (count === 0) return
      setBatchMode('undo')
      setBatchCount(count)
      setBatchThroughId(entryId)
      setBatchDialogOpen(true)
    },
    [activities],
  )

  const handleRedoToHere = useCallback(
    (entryId: number) => {
      // Count undone entries from the bottom up to (and including) this entry
      const count = activities.filter((a) => a.undone && a.id <= entryId).length
      if (count === 0) return
      setBatchMode('redo')
      setBatchCount(count)
      setBatchThroughId(entryId)
      setBatchDialogOpen(true)
    },
    [activities],
  )

  const handleBatchConfirm = useCallback(async () => {
    if (batchThroughId === null) return
    setBatchDialogOpen(false)

    const endpoint = batchMode === 'undo' ? '/api/undo/batch' : '/api/redo/batch'
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ through_id: batchThroughId }),
      })
      if (!res.ok) {
        showToast({ message: `${batchMode === 'undo' ? 'Undo' : 'Redo'} failed`, type: 'error' })
        return
      }
      const data = await res.json()
      showToast({
        message: `${batchMode === 'undo' ? 'Undid' : 'Redid'} ${data.data.count} actions`,
        type: 'success',
      })
      onRefresh()
    } catch {
      showToast({ message: `${batchMode === 'undo' ? 'Undo' : 'Redo'} failed`, type: 'error' })
    }
  }, [batchMode, batchThroughId, onRefresh])

  return (
    <div>
      {loading ? (
        <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
      ) : activities.length === 0 ? (
        <p className="py-8 text-center text-zinc-400">No activity recorded.</p>
      ) : (
        <div>
          {activities.map((a, i) => {
            const showSep = i > 0 && shouldShowSeparator(activities[i - 1], a, now)
            return (
              <div key={a.id}>
                {/* Time-ago pill: shows how long ago the entries below occurred */}
                {showSep && (
                  <div className="flex items-end gap-2 pt-1.5 pb-4">
                    <div className="h-1.5 flex-1 rounded-bl-md border-b border-l border-zinc-200/60 dark:border-zinc-700/60" />
                    <span className="translate-y-[5px] text-[11px] leading-none text-zinc-400/70">
                      {formatTimeAgoLabel(activities[i - 1], now, timezone)}
                    </span>
                    <div className="h-1.5 flex-1 rounded-br-md border-r border-b border-zinc-200/60 dark:border-zinc-700/60" />
                  </div>
                )}
                <div className={i > 0 && !showSep ? 'mt-2' : ''}>
                  <ExpandableActivityItem
                    activity={a}
                    timezone={timezone}
                    onUndoToHere={!a.undone ? () => handleUndoToHere(a.id) : undefined}
                    onRedoToHere={a.undone ? () => handleRedoToHere(a.id) : undefined}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <BatchUndoDialog
        open={batchDialogOpen}
        onOpenChange={setBatchDialogOpen}
        mode={batchMode}
        count={batchCount}
        onConfirm={handleBatchConfirm}
        context="history"
      />
    </div>
  )
}

/**
 * Expandable activity item with chevron to show/hide full details.
 * Collapsed: shows truncated description with chevron
 * Expanded: shows full description, field badges, and before/after values
 * Includes "Undo to here" or "Redo to here" action button.
 */
function ExpandableActivityItem({
  activity,
  timezone,
  onUndoToHere,
  onRedoToHere,
}: {
  activity: UndoEntry
  timezone: string
  onUndoToHere?: () => void
  onRedoToHere?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = activity.snapshot.length > 0 || activity.fields_changed.length > 0

  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-800',
        activity.undone && 'border-l-4 border-l-amber-300 dark:border-l-amber-600',
        hasDetails && 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
      )}
    >
      {/* Header - always visible, clickable if has details */}
      <div className="flex items-center gap-1 pr-2">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 p-3 text-left',
            hasDetails && 'cursor-pointer',
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
            <p className={cn('text-sm font-medium', !expanded && 'truncate')}>
              {formatActivityDescription(activity, timezone)}
            </p>
            <p className="text-xs text-zinc-400">
              {new Date(activity.created_at).toLocaleString('en-US', {
                timeZone: timezone,
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}
              {activity.undone && ' (undone)'}
            </p>
          </div>
        </button>

        {/* Undo/Redo to here button */}
        {onUndoToHere && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onUndoToHere}
            className="text-muted-foreground hover:text-foreground flex-shrink-0 gap-1 text-xs"
          >
            <Undo2 className="size-3" />
            Undo to here
          </Button>
        )}
        {onRedoToHere && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRedoToHere}
            className="text-muted-foreground hover:text-foreground flex-shrink-0 gap-1 text-xs"
          >
            <Redo2 className="size-3" />
            Redo to here
          </Button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
          <ActivityDetails activity={activity} timezone={timezone} />
        </div>
      )}
    </div>
  )
}

/**
 * Shows detailed information about an activity entry:
 * - Fields changed badges
 * - Before/after values for each changed field
 * - For bulk operations: task count and first few task titles
 */
function ActivityDetails({ activity, timezone }: { activity: UndoEntry; timezone: string }) {
  const { snapshot, fields_changed } = activity
  const isBulk = activity.action.startsWith('bulk_')

  // Filter out internal fields that shouldn't be shown to users
  const displayFields = fields_changed.filter(
    (f) =>
      !['anchor_time', 'anchor_dow', 'anchor_dom', 'updated_at', 'original_due_at'].includes(f),
  )

  return (
    <div className="space-y-3 text-sm">
      {/* Fields changed badges */}
      {displayFields.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500">Changed:</span>
          {displayFields.map((field) => (
            <Badge key={field} variant="secondary" className="text-xs">
              {formatFieldName(field)}
            </Badge>
          ))}
        </div>
      )}

      {/* For bulk operations, show affected task titles */}
      {isBulk && snapshot.length > 0 && (
        <div className="text-xs text-zinc-500">
          <span className="font-medium">{snapshot.length} tasks:</span>{' '}
          {snapshot
            .slice(0, 5)
            .map((s) => s.before_state?.title || s.after_state?.title || `#${s.task_id}`)
            .join(', ')}
          {snapshot.length > 5 && ` +${snapshot.length - 5} more`}
        </div>
      )}

      {/* For single task, show before/after details */}
      {!isBulk && snapshot.length === 1 && (
        <div className="space-y-1.5">
          {displayFields.map((field) => {
            const detail = formatFieldDetail(snapshot[0], field, timezone)
            if (!detail) return null
            return (
              <div key={field} className="flex gap-2 text-xs">
                <span className="font-medium text-zinc-600 dark:text-zinc-400">
                  {formatFieldName(field)}:
                </span>
                <span className="text-zinc-500">{detail}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Format a field name for display (e.g., 'due_at' -> 'Due date')
 */
function formatFieldName(field: string): string {
  // Extra fields not in FIELD_LABELS
  const extras: Record<string, string> = {
    done: 'Status',
    done_at: 'Done at',
    archived_at: 'Archived',
    deleted_at: 'Deleted',
    snooze_count: 'Snooze count',
  }
  const label = FIELD_LABELS[field] || extras[field]
  if (label) return label.charAt(0).toUpperCase() + label.slice(1)
  return field.replace(/_/g, ' ')
}

/**
 * Format a single field's before/after values for display
 */
function formatFieldDetail(snapshot: UndoSnapshot, field: string, timezone: string): string | null {
  const { before_state, after_state } = snapshot

  switch (field) {
    case 'priority': {
      const before = formatPriority(before_state.priority)
      const after = formatPriority(after_state.priority)
      return `${before} → ${after}`
    }
    case 'title': {
      const before = before_state.title ?? '(none)'
      const after = after_state.title ?? '(none)'
      const truncBefore = before.length > 25 ? before.slice(0, 25) + '…' : before
      const truncAfter = after.length > 25 ? after.slice(0, 25) + '…' : after
      return `"${truncBefore}" → "${truncAfter}"`
    }
    case 'due_at': {
      const before = before_state.due_at
        ? formatTimeInTimezone(before_state.due_at, timezone)
        : '(none)'
      const after = after_state.due_at
        ? formatTimeInTimezone(after_state.due_at, timezone)
        : '(none)'
      return `${before} → ${after}`
    }
    case 'done': {
      const before = before_state.done ? 'Done' : 'Not done'
      const after = after_state.done ? 'Done' : 'Not done'
      return `${before} → ${after}`
    }
    case 'labels': {
      const before = (before_state.labels || []).join(', ') || '(none)'
      const after = (after_state.labels || []).join(', ') || '(none)'
      return `${before} → ${after}`
    }
    case 'rrule': {
      const before = before_state.rrule ? 'Has recurrence' : 'None'
      const after = after_state.rrule ? 'Has recurrence' : 'None'
      return `${before} → ${after}`
    }
    case 'snooze_count': {
      const before = before_state.snooze_count ?? 0
      const after = after_state.snooze_count ?? 0
      return `${before} → ${after}`
    }
    default:
      return null
  }
}

// --- AI Tab ---

const ACTIVITY_PAGE_SIZE = 20

function AITab({ timezone }: { timezone: string }) {
  const [data, setData] = useState<AIStatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [actionFilter, setActionFilter] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Ref tracks current data so fetchStatus can read it without depending on it.
  // This avoids a stale closure: the effect should re-run when actionFilter changes
  // (to refetch), but not when data changes (which would cause an infinite loop).
  const dataRef = useRef(data)
  dataRef.current = data

  const fetchStatus = useCallback(
    async (opts: { append?: boolean; offset?: number } = {}) => {
      const { append = false, offset = 0 } = opts
      if (!append) setLoading(true)
      setError(false)
      try {
        const params = new URLSearchParams({
          limit: String(ACTIVITY_PAGE_SIZE),
          offset: String(offset),
        })
        if (actionFilter) params.set('action', actionFilter)

        const res = await fetch(`/api/ai/status?${params}`)
        if (!res.ok) {
          setError(true)
          return
        }
        const json = await res.json()
        if (json.data) {
          const current = dataRef.current
          if (append && current) {
            // Append new activity entries to existing data
            setData({
              ...json.data,
              recent_activity: [...current.recent_activity, ...json.data.recent_activity],
            })
          } else {
            setData(json.data)
          }
          setHasMore(json.data.recent_activity.length >= ACTIVITY_PAGE_SIZE)
        }
      } catch {
        setError(true)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [actionFilter],
  )

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleLoadMore = useCallback(() => {
    if (!data || loadingMore) return
    setLoadingMore(true)
    fetchStatus({ append: true, offset: data.recent_activity.length })
  }, [data, loadingMore, fetchStatus])

  const handleActionFilterChange = useCallback((action: string) => {
    setActionFilter(action)
  }, [])

  const handleRefresh = useCallback(() => {
    fetchStatus()
  }, [fetchStatus])

  if (loading) {
    return <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
  }

  if (error || !data) {
    return (
      <div className="py-8 text-center">
        <p className="text-zinc-400">{error ? 'AI features are not available.' : 'No data.'}</p>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="mt-2">
          Retry
        </Button>
      </div>
    )
  }

  return (
    <AIStatusContent
      data={data}
      timezone={timezone}
      onRefresh={handleRefresh}
      showFilters
      actionFilter={actionFilter}
      onActionFilterChange={handleActionFilterChange}
      hasMore={hasMore}
      onLoadMore={handleLoadMore}
      loadingMore={loadingMore}
    />
  )
}
