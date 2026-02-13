'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { formatRelativeTime } from '@/lib/quick-select-dates'
import type { BubbleResult } from '@/core/ai/types'
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
  hasData: boolean
  /** Error message from the last failed refresh, cleared on next refresh() */
  error: string | null
  refresh: () => void
}

/**
 * Hook that fetches AI bubble recommendations and resolves them against
 * the current task list. Replaces BubblePanel's fetch/cache logic.
 *
 * - Fetches GET /api/ai/bubble on mount (once, when tasks are available)
 * - Resolves task IDs against current task list (skips completed/deleted)
 * - refresh() calls /api/ai/bubble?refresh=true
 * - Silent failure on 503 (AI disabled) — returns empty maps
 */
export function useAiInsights(tasks: Task[]): UseAiInsightsReturn {
  const [data, setData] = useState<BubbleResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasFetched = useRef(false)

  const fetchRecommendations = useCallback(async (refresh = false) => {
    // Only show loading indicator for manual refreshes — the initial mount fetch
    // reads cached data from the DB (zero AI processing), so no spinner needed.
    if (refresh) {
      setLoading(true)
      setError(null)
    }
    try {
      const url = refresh ? '/api/ai/bubble?refresh=true' : '/api/ai/bubble'
      const res = await fetch(url)
      if (res.status === 503) return
      if (!res.ok) {
        if (refresh) setError('Bubble refresh failed')
        return
      }
      const json = await res.json()
      if (json.data) {
        setData(json.data)
      }
    } catch {
      if (refresh) setError('Bubble refresh failed')
    } finally {
      if (refresh) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (hasFetched.current) return
    if (tasks.length > 0) {
      hasFetched.current = true
      fetchRecommendations()
    }
  }, [tasks.length, fetchRecommendations])

  // Resolve bubble task IDs against the current task list
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
    hasData,
    error,
    refresh,
  }
}
