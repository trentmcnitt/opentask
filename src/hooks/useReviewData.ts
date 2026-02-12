'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Task } from '@/types'

export interface ReviewResultItem {
  task_id: number
  score: number
  commentary: string
  signals: string[]
  generated_at: string
}

export interface SignalDef {
  key: string
  label: string
  color: string
  description: string
}

export interface UseReviewDataReturn {
  results: ReviewResultItem[]
  signals: SignalDef[]
  signalCounts: Record<string, number>
  generatedAt: string | null
  generating: boolean
  progress: number
  totalTasks: number
  completedTasks: number
  /** Map of taskId -> commentary text */
  annotationMap: Map<number, string>
  /** Map of taskId -> review score (0-100) */
  reviewScoreMap: Map<number, number>
  /** Map of taskId -> signal keys */
  reviewSignalMap: Map<number, string[]>
  /** Signals that have at least one task */
  activeSignals: SignalDef[]
  /** Whether any review results exist */
  hasResults: boolean
  /** Start or refresh review generation */
  generate: () => Promise<void>
  /** Fetch cached results without generating */
  fetchResults: () => Promise<void>
}

/**
 * Hook that manages AI review data: fetching cached results, triggering
 * generation, polling for progress, and deriving annotation/score/signal maps.
 *
 * Extracted from review/page.tsx to enable reuse in the dashboard.
 */
export function useReviewData(tasks: Task[]): UseReviewDataReturn {
  const [results, setResults] = useState<ReviewResultItem[]>([])
  const [signals, setSignals] = useState<SignalDef[]>([])
  const [signalCounts, setSignalCounts] = useState<Record<string, number>>({})
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [totalTasks, setTotalTasks] = useState(0)
  const [completedTasks, setCompletedTasks] = useState(0)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch cached review results
  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch('/api/review/results')
      if (!res.ok) return
      const json = await res.json()
      if (json.data) {
        setResults(json.data.results || [])
        setSignals(json.data.signals || [])
        setSignalCounts(json.data.signal_counts || {})
        setGeneratedAt(json.data.generated_at)
      }
    } catch {
      // Silently fail
    }
  }, [])

  // Poll for generation progress
  const startPolling = useCallback(
    (sessionId: string) => {
      if (pollRef.current) clearInterval(pollRef.current)

      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/review/status?session_id=${sessionId}`)
          if (!res.ok) return
          const json = await res.json()
          const data = json.data

          setCompletedTasks(data.completed)
          setProgress(data.progress_pct)

          if (data.status === 'complete' || data.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setGenerating(false)
            await fetchResults()
          }
        } catch {
          // Keep polling on transient errors
        }
      }, 2000)
    },
    [fetchResults],
  )

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Generate review
  const generate = useCallback(async () => {
    setGenerating(true)
    setProgress(0)
    setCompletedTasks(0)

    try {
      const res = await fetch('/api/review/generate', { method: 'POST' })
      if (!res.ok) {
        setGenerating(false)
        return
      }
      const json = await res.json()
      const data = json.data

      if (!data.session_id) {
        // No tasks to review
        setGenerating(false)
        return
      }

      setTotalTasks(data.total_tasks)
      startPolling(data.session_id)
    } catch {
      setGenerating(false)
    }
  }, [startPolling])

  // Build derived maps from results
  const { annotationMap, reviewScoreMap, reviewSignalMap } = useMemo(() => {
    const annMap = new Map<number, string>()
    const scoreMap = new Map<number, number>()
    const sigMap = new Map<number, string[]>()

    for (const r of results) {
      annMap.set(r.task_id, r.commentary)
      scoreMap.set(r.task_id, r.score)
      if (r.signals.length > 0) sigMap.set(r.task_id, r.signals)
    }

    return {
      annotationMap: annMap,
      reviewScoreMap: scoreMap,
      reviewSignalMap: sigMap,
    }
  }, [results])

  const activeSignals = useMemo(
    () => signals.filter((s) => (signalCounts[s.key] || 0) > 0),
    [signals, signalCounts],
  )

  const hasResults = results.length > 0

  // Fetch results on mount when tasks are available.
  // Uses an AbortController pattern to satisfy the set-state-in-effect lint rule:
  // the fetch is kicked off inline but setState only fires in the .then() callback.
  const hasFetched = useRef(false)
  useEffect(() => {
    if (hasFetched.current || tasks.length === 0) return
    hasFetched.current = true
    let cancelled = false
    fetch('/api/review/results')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return
        setResults(json.data.results || [])
        setSignals(json.data.signals || [])
        setSignalCounts(json.data.signal_counts || {})
        setGeneratedAt(json.data.generated_at)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tasks.length])

  return {
    results,
    signals,
    signalCounts,
    generatedAt,
    generating,
    progress,
    totalTasks,
    completedTasks,
    annotationMap,
    reviewScoreMap,
    reviewSignalMap,
    activeSignals,
    hasResults,
    generate,
    fetchResults,
  }
}
