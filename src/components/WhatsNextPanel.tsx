'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, Sparkles, Loader2, RefreshCw } from 'lucide-react'
import type { WhatsNextResult } from '@/core/ai/types'
import type { Task } from '@/types'

interface WhatsNextPanelProps {
  tasks: Task[]
  onDone: (taskId: number) => void
  onActivate: (taskId: number) => void
}

/**
 * AI-powered "What's Next?" panel for the dashboard.
 *
 * Shows 3-7 recommended tasks with reasons. Collapsible, remembers
 * state in localStorage. Fails silently if AI is unavailable.
 */
export default function WhatsNextPanel({ tasks, onDone, onActivate }: WhatsNextPanelProps) {
  const [data, setData] = useState<WhatsNextResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('whats-next-collapsed') === 'true'
  })

  const fetchRecommendations = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/ai/whats-next')
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

  useEffect(() => {
    if (tasks.length > 0) {
      fetchRecommendations()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- fetch once on mount

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('whats-next-collapsed', String(next))
  }

  // Don't render if error or no data and not loading
  if (error && !data) return null
  if (!loading && !data) return null

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20">
      {/* Header */}
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
            <span className="line-clamp-1 text-sm font-medium text-blue-800 dark:text-blue-200">
              {data?.summary || "What's Next?"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {data && !loading && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                fetchRecommendations()
              }}
              className="rounded p-1 text-blue-500 hover:bg-blue-200/50 dark:hover:bg-blue-800/50"
              title="Refresh recommendations"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-blue-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-blue-500" />
          )}
        </div>
      </button>

      {/* Body */}
      {!collapsed && data && (
        <div className="border-t border-blue-200 dark:border-blue-900">
          {data.tasks.map((rec) => {
            const task = tasks.find((t) => t.id === rec.task_id)
            if (!task) return null

            return (
              <div
                key={rec.task_id}
                className="flex items-start gap-3 border-b border-blue-100 px-3 py-2 last:border-b-0 dark:border-blue-900/50"
              >
                <button
                  onClick={() => onDone(rec.task_id)}
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-blue-300 hover:border-blue-500 hover:bg-blue-100 dark:border-blue-600 dark:hover:border-blue-400"
                  title="Mark done"
                >
                  <span className="sr-only">Complete</span>
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => onActivate(rec.task_id)}
                    className="line-clamp-1 text-left text-sm font-medium text-zinc-900 hover:text-blue-700 dark:text-zinc-100 dark:hover:text-blue-300"
                  >
                    {task.title}
                  </button>
                  <p className="line-clamp-1 text-xs text-blue-600/80 dark:text-blue-400/80">
                    {rec.reason}
                  </p>
                </div>
              </div>
            )
          })}
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
