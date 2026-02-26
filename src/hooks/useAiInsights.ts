'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { formatRelativeTime } from '@/lib/quick-select-dates'
import { showToast, showAiSuccessToast, showErrorToast } from '@/lib/toast'
import type { WhatsNextResult } from '@/core/ai/types'
import type { Task } from '@/types'

export interface UseAiInsightsReturn {
  /** taskId -> reason text */
  annotationMap: Map<number, string>
  /** Set of task IDs with AI insights for quick filter checks */
  aiTaskIds: Set<number>
  /** AI summary text */
  summary: string | null
  loading: boolean
  /** e.g. "2h ago" */
  freshnessText: string | null
  /** Raw ISO timestamp from generation, for tooltip display */
  generatedAt: string | null
  /** Duration in ms of the last generation */
  durationMs: number | null
  hasData: boolean
  /** Error message from the last failed refresh, cleared on next refresh() */
  error: string | null
  refresh: () => void
}

/**
 * Hook that fetches AI What's Next recommendations and resolves them against
 * the current task list.
 *
 * - Fetches GET /api/ai/whats-next on mount (once, when tasks are available)
 * - Resolves task IDs against current task list (skips completed/deleted)
 * - refresh() calls /api/ai/whats-next?refresh=true
 * - Silent failure on 503 (AI disabled) — returns empty maps
 */
export function useAiInsights(tasks: Task[], enabled = true): UseAiInsightsReturn {
  const [data, setData] = useState<WhatsNextResult | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasFetched = useRef(false)

  const fetchRecommendations = useCallback(async (refresh = false) => {
    // Only show loading indicator for manual refreshes — the initial mount fetch
    // reads cached data from the DB (zero AI processing), so no spinner needed.
    if (refresh) {
      setLoading(true)
      setError(null)
      showToast({ message: "Refreshing What's Next…" })
    }
    try {
      const url = refresh ? '/api/ai/whats-next?refresh=true' : '/api/ai/whats-next'
      const res = await fetch(url)
      if (res.status === 503) return
      if (!res.ok) {
        if (refresh) {
          const msg = "What's Next refresh failed"
          setError(msg)
          showErrorToast(msg)
        }
        return
      }
      const json = await res.json()
      if (json.data) {
        setData(json.data)
        setDurationMs(json.data.duration_ms ?? null)
        if (refresh) showAiSuccessToast("What's Next updated")
      }
    } catch {
      if (refresh) {
        const msg = "What's Next refresh failed"
        setError(msg)
        showErrorToast(msg)
      }
    } finally {
      if (refresh) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (hasFetched.current) return
    if (tasks.length > 0) {
      hasFetched.current = true
      fetchRecommendations()
    }
  }, [tasks.length, fetchRecommendations, enabled])

  // Resolve What's Next task IDs against the current task list
  const taskIdSet = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks])

  const annotationMap = useMemo(() => {
    const map = new Map<number, string>()
    if (!data) return map
    for (const rec of data.tasks) {
      if (taskIdSet.has(rec.task_id)) {
        map.set(rec.task_id, rec.reason)
      }
    }
    return map
  }, [data, taskIdSet])

  const aiTaskIds = useMemo(() => new Set(annotationMap.keys()), [annotationMap])

  const summary = data?.summary || null
  const freshnessText = data?.generated_at ? formatRelativeTime(data.generated_at) : null
  const hasData = annotationMap.size > 0

  const refresh = useCallback(() => {
    fetchRecommendations(true)
  }, [fetchRecommendations])

  return {
    annotationMap,
    aiTaskIds,
    summary,
    loading,
    freshnessText,
    generatedAt: data?.generated_at || null,
    durationMs,
    hasData,
    error,
    refresh,
  }
}
