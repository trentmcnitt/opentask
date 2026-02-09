'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown, ChevronRight, Sparkles, Loader2, RefreshCw } from 'lucide-react'
import { TaskRow } from './TaskRow'
import { SwipeableRow } from './SwipeableRow'
import { isTaskOverdue } from './TaskList'
import { useSelectionOptional, type SelectionContextType } from './SelectionProvider'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { computeSnoozeTime } from '@/lib/snooze'
import { useTimezone } from '@/hooks/useTimezone'
import { formatRelativeTime } from '@/lib/quick-select-dates'
import type { BubbleResult } from '@/core/ai/types'
import type { Task } from '@/types'

const fallbackSelection: SelectionContextType = {
  selectedIds: new Set(),
  anchor: null,
  isSelectionMode: false,
  toggle: () => {},
  rangeSelect: () => {},
  selectAll: () => {},
  selectOnly: () => {},
  addAll: () => {},
  removeAll: () => {},
  clear: () => {},
}

interface BubblePanelProps {
  tasks: Task[]
  onDone: (taskId: number) => void
  onSnooze: (taskId: number, until: string) => void
  onActivate: (taskId: number) => void
  onDoubleClick?: (task: Task) => void
  onLabelClick?: (label: string) => void
}

/**
 * AI-powered "Bubble" panel for the dashboard.
 *
 * Surfaces tasks that would be easily overlooked — not just urgent items,
 * but things like social obligations, tasks sitting idle, and things
 * without hard deadlines that would become regrets.
 *
 * Layout:
 *   Header: [Sparkles] Bubble  [refresh] [2h ago] [chevron]
 *   Body:   AI summary text
 *           ─── divider ───
 *           TaskRow with annotation (AI reason) for each recommendation
 *
 * Tasks render using the standard TaskRow + SwipeableRow, so they look
 * and behave identically to tasks in the main list (metadata, swipe
 * gestures, selection mode, etc.).
 *
 * Collapsible, remembers state in localStorage. Fails silently if AI
 * is unavailable.
 */
export default function BubblePanel({
  tasks,
  onDone,
  onSnooze,
  onActivate,
  onDoubleClick,
  onLabelClick,
}: BubblePanelProps) {
  const [data, setData] = useState<BubbleResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('bubble-collapsed') === 'true'
  })

  const selection = useSelectionOptional() ?? fallbackSelection
  const timezone = useTimezone()
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()

  const handleSwipeSnooze = useCallback(
    (task: Task) => {
      const until = computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)
      onSnooze(task.id, until)
    },
    [defaultSnoozeOption, timezone, morningTime, onSnooze],
  )

  const fetchRecommendations = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(false)
    try {
      const url = refresh ? '/api/ai/bubble?refresh=true' : '/api/ai/bubble'
      const res = await fetch(url)
      if (res.status === 503) {
        return
      }
      if (!res.ok) {
        setError(true)
        return
      }
      const json = await res.json()
      if (json.data) {
        setData(json.data)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const hasFetched = useRef(false)
  useEffect(() => {
    if (hasFetched.current) return
    if (tasks.length > 0) {
      hasFetched.current = true
      fetchRecommendations()
    }
  }, [tasks.length, fetchRecommendations])

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('bubble-collapsed', String(next))
  }

  // Don't render if error or no data and not loading
  if (error && !data) return null
  if (!loading && !data) return null

  // When we have data, resolve bubble tasks against the current task list.
  // Tasks that were completed/deleted since bubble was generated are skipped.
  const resolvedTasks = data
    ? data.tasks
        .map((rec) => ({ rec, task: tasks.find((t) => t.id === rec.task_id) }))
        .filter((item): item is { rec: (typeof data.tasks)[0]; task: Task } => !!item.task)
    : []

  // If all bubble tasks are gone, hide the panel entirely
  if (data && resolvedTasks.length === 0 && !loading) return null

  const freshnessText = data?.generated_at ? formatRelativeTime(data.generated_at) : null

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20">
      {/* Header: [Sparkles] Bubble  [refresh] [freshness] [chevron] */}
      <button
        onClick={toggleCollapsed}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-blue-100/50 dark:hover:bg-blue-900/20"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0 flex-1">
          {loading && !data ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              <span className="text-sm text-blue-700 dark:text-blue-300">
                Analyzing your tasks...
              </span>
            </div>
          ) : (
            <span className="text-sm font-medium text-blue-800 dark:text-blue-200">Bubble</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {data && !loading && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                fetchRecommendations(true)
              }}
              className="rounded p-1 text-blue-500 hover:bg-blue-200/50 dark:hover:bg-blue-800/50"
              title="Refresh recommendations"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
          {freshnessText && !loading && (
            <span className="text-xs text-blue-500/70">{freshnessText}</span>
          )}
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-blue-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-blue-500" />
          )}
        </div>
      </button>

      {/* Body: summary + task list */}
      {!collapsed && data && (
        <div className="border-t border-blue-200 dark:border-blue-900">
          {/* AI summary */}
          {data.summary && (
            <p className="px-3 py-2 text-sm text-blue-700/80 dark:text-blue-300/80">
              {data.summary}
            </p>
          )}

          {/* Divider between summary and tasks */}
          {data.summary && resolvedTasks.length > 0 && (
            <div className="border-t border-blue-200/60 dark:border-blue-900/60" />
          )}

          {/* Task list using real TaskRow + SwipeableRow */}
          <div className="space-y-1 p-1">
            {resolvedTasks.map(({ rec, task }) => (
              <SwipeableRow
                key={rec.task_id}
                onSwipeRight={() => onDone(rec.task_id)}
                onSwipeLeft={() => handleSwipeSnooze(task)}
                disabled={selection.isSelectionMode}
              >
                <TaskRow
                  task={task}
                  onDone={() => onDone(rec.task_id)}
                  onSnooze={onSnooze}
                  isOverdue={isTaskOverdue(task)}
                  isSelected={selection.selectedIds.has(rec.task_id)}
                  isSelectionMode={selection.isSelectionMode}
                  onSelect={() => selection.toggle(rec.task_id)}
                  onSelectOnly={() => selection.selectOnly(rec.task_id)}
                  onActivate={() => onActivate(rec.task_id)}
                  onDoubleClick={onDoubleClick ? () => onDoubleClick(task) : undefined}
                  onLabelClick={onLabelClick}
                  annotation={rec.reason}
                />
              </SwipeableRow>
            ))}
          </div>
        </div>
      )}

      {/* Loading overlay for refresh */}
      {loading && data && (
        <div className="border-t border-blue-200 px-3 py-2 dark:border-blue-900">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            <span className="text-xs text-blue-600 dark:text-blue-400">Refreshing...</span>
          </div>
        </div>
      )}
    </div>
  )
}
