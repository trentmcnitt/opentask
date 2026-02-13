'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { showToast, showAiSuccessToast, showErrorToast } from '@/lib/toast'
import type { Task } from '@/types'

export interface InsightsResultItem {
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

export interface UseInsightsDataReturn {
  results: InsightsResultItem[]
  signals: SignalDef[]
  signalCounts: Record<string, number>
  generatedAt: string | null
  generating: boolean
  progress: number
  totalTasks: number
  completedTasks: number
  /** Map of taskId -> commentary text */
  annotationMap: Map<number, string>
  /** Map of taskId -> insights score (0-100) */
  insightsScoreMap: Map<number, number>
  /** Map of taskId -> signal keys */
  insightsSignalMap: Map<number, string[]>
  /** Signals that have at least one task */
  activeSignals: SignalDef[]
  /** Whether any insights results exist */
  hasResults: boolean
  /** True when all tasks fit in a single AI call (no incremental progress) */
  singleCall: boolean
  /** Error message from the last failed generation attempt, cleared on next generate() */
  error: string | null
  /** ISO timestamp of when the current generation started (for elapsed timer continuity across refreshes) */
  generationStartedAt: string | null
  /** Start or refresh insights generation */
  generate: () => Promise<void>
  /** Fetch cached results without generating */
  fetchResults: () => Promise<void>
}

/**
 * Hook that manages AI insights data: fetching cached results, triggering
 * generation, polling for progress, and deriving annotation/score/signal maps.
 *
 * Extracted to enable reuse in the dashboard.
 */
export function useInsightsData(tasks: Task[]): UseInsightsDataReturn {
  const [results, setResults] = useState<InsightsResultItem[]>([])
  const [signals, setSignals] = useState<SignalDef[]>([])
  const [signalCounts, setSignalCounts] = useState<Record<string, number>>({})
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [totalTasks, setTotalTasks] = useState(0)
  const [completedTasks, setCompletedTasks] = useState(0)
  const [singleCall, setSingleCall] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generationStartedAt, setGenerationStartedAt] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch cached insights results
  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/insights/results')
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
          const res = await fetch(`/api/ai/insights/status?session_id=${sessionId}`)
          if (!res.ok) return
          const json = await res.json()
          const data = json.data

          setCompletedTasks(data.completed)
          setProgress(data.progress_pct)

          if (data.status === 'complete' || data.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setGenerating(false)
            setGenerationStartedAt(null)
            if (data.status === 'failed') {
              const msg = data.error || 'Insights generation failed'
              setError(msg)
              showErrorToast(msg)
            } else {
              showAiSuccessToast('Insights updated')
            }
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

  /** Resume polling for an existing session (used by 409 handling and mount recovery). */
  const resumeSession = useCallback(
    (sessionId: string, completed: number, total: number, startedAt?: string) => {
      setGenerating(true)
      setTotalTasks(total)
      setCompletedTasks(completed)
      setProgress(total > 0 ? Math.round((completed / total) * 100) : 0)
      setSingleCall(false)
      setGenerationStartedAt(startedAt || null)
      startPolling(sessionId)
    },
    [startPolling],
  )

  // Generate insights
  const generate = useCallback(async () => {
    setError(null)

    try {
      const res = await fetch('/api/ai/insights/generate', { method: 'POST' })

      // Session already running — resume polling instead of showing error
      if (res.status === 409) {
        const json = await res.json()
        const details = json.details
        if (details?.session_id) {
          resumeSession(
            details.session_id,
            details.completed || 0,
            details.total_tasks || 0,
            details.started_at,
          )
          return
        }
      }

      if (!res.ok) {
        const msg = 'Failed to start insights generation'
        setError(msg)
        showErrorToast(msg)
        return
      }

      const json = await res.json()
      const data = json.data

      if (!data.session_id) {
        // No tasks to analyze
        return
      }

      setGenerating(true)
      setProgress(0)
      setCompletedTasks(0)
      setTotalTasks(data.total_tasks)
      setSingleCall(!!data.single_call)
      setGenerationStartedAt(data.started_at)
      showToast({ message: 'Generating insights…' })
      startPolling(data.session_id)
    } catch {
      const msg = 'Failed to start insights generation'
      setError(msg)
      showErrorToast(msg)
    }
  }, [startPolling, resumeSession])

  // Build derived maps from results
  const { annotationMap, insightsScoreMap, insightsSignalMap } = useMemo(() => {
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
      insightsScoreMap: scoreMap,
      insightsSignalMap: sigMap,
    }
  }, [results])

  const activeSignals = useMemo(
    () => signals.filter((s) => (signalCounts[s.key] || 0) > 0),
    [signals, signalCounts],
  )

  const hasResults = results.length > 0

  // Fetch results on mount when tasks are available.
  // Also checks for an active generation session and resumes polling if found
  // (handles page refresh mid-generation).
  const hasFetched = useRef(false)
  useEffect(() => {
    if (hasFetched.current || tasks.length === 0) return
    hasFetched.current = true
    let cancelled = false
    fetch('/api/ai/insights/results')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return
        setResults(json.data.results || [])
        setSignals(json.data.signals || [])
        setSignalCounts(json.data.signal_counts || {})
        setGeneratedAt(json.data.generated_at)

        // Resume polling if a session is actively running (e.g. page was refreshed mid-generation)
        const active = json.data.active_session
        if (active?.session_id) {
          resumeSession(
            active.session_id,
            active.completed || 0,
            active.total_tasks || 0,
            active.started_at,
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tasks.length, resumeSession])

  return {
    results,
    signals,
    signalCounts,
    generatedAt,
    generating,
    progress,
    totalTasks,
    completedTasks,
    singleCall,
    generationStartedAt,
    annotationMap,
    insightsScoreMap,
    insightsSignalMap,
    activeSignals,
    hasResults,
    error,
    generate,
    fetchResults,
  }
}
