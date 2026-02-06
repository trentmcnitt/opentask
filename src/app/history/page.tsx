'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatDurationDelta, formatTimeInTimezone } from '@/lib/format-date'
import { FIELD_LABELS, truncateTitle } from '@/lib/field-labels'
import { getPriorityOption } from '@/lib/priority'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
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

type TabId = 'completions' | 'activity'

export default function HistoryPage() {
  const { status } = useSession()
  const router = useRouter()
  const timezone = useTimezone()
  const [tab, setTab] = useState<TabId>('completions')
  const [completions, setCompletions] = useState<CompletionEntry[]>([])
  const [activities, setActivities] = useState<UndoEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0])

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
          const res = await fetch('/api/undo/history?limit=50')
          if (res.ok) {
            const data = await res.json()
            setActivities(data.data?.history || [])
          }
        }
      } catch {
        // Handled silently
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [status, router, tab, date])

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">History</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {/* Tab bar */}
        <div className="mb-6 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
          <button
            onClick={() => setTab('completions')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'completions'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Completions
          </button>
          <button
            onClick={() => setTab('activity')}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              tab === 'activity'
                ? 'bg-white shadow-sm dark:bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            Activity
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
          <ActivityTab loading={loading} activities={activities} timezone={timezone} />
        )}
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

function ActivityTab({
  loading,
  activities,
  timezone,
}: {
  loading: boolean
  activities: UndoEntry[]
  timezone: string
}) {
  return (
    <div>
      {loading ? (
        <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
      ) : activities.length === 0 ? (
        <p className="py-8 text-center text-zinc-400">No activity recorded.</p>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => (
            <ExpandableActivityItem key={a.id} activity={a} timezone={timezone} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Expandable activity item with chevron to show/hide full details.
 * Collapsed: shows truncated description with chevron
 * Expanded: shows full description, field badges, and before/after values
 */
function ExpandableActivityItem({ activity, timezone }: { activity: UndoEntry; timezone: string }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = activity.snapshot.length > 0 || activity.fields_changed.length > 0

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Header - always visible, clickable if has details */}
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-3 p-3 text-left',
          hasDetails && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900',
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

        <span className={activity.undone ? 'text-zinc-400' : 'text-blue-500'}>
          {activity.undone ? '○' : '●'}
        </span>

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
        <div className="flex flex-wrap gap-1.5">
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
