'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAiPreferences } from '@/components/PreferencesProvider'

export type AiMode = 'off' | 'on'

export interface UseAiModeReturn {
  mode: AiMode
  setMode: (mode: AiMode) => void
  showInsights: boolean
  setShowInsights: (show: boolean) => void
  wnCommentaryUnfiltered: boolean
  setWnCommentaryUnfiltered: (show: boolean) => void
  wnHighlight: boolean
  setWnHighlight: (show: boolean) => void
  insightsSignalChips: boolean
  setInsightsSignalChips: (show: boolean) => void
  insightsScoreChips: boolean
  setInsightsScoreChips: (show: boolean) => void
}

/** Fire-and-forget PATCH to persist a preference change server-side. */
function patchPreference(fields: Record<string, unknown>) {
  fetch('/api/user/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).catch(() => {})
}

/**
 * Manages AI mode toggle state (Off / On) and visibility preferences:
 * - Insights chip toggle (showInsights)
 * - WN commentary when not filtering, WN background highlight
 * - Signal/score chip visibility when Insights chip is off
 *
 * Backed by PreferencesProvider (server-persisted per user).
 *
 * On first load, migrates any leftover localStorage keys to the server
 * and deletes them.
 */
export function useAiMode(): UseAiModeReturn {
  const {
    aiMode,
    setAiMode,
    setAiShowScores,
    aiShowInsights,
    setAiShowInsights,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
  } = useAiPreferences()
  const migrated = useRef(false)

  // One-time migration from localStorage → server
  useEffect(() => {
    if (migrated.current || typeof window === 'undefined') return
    migrated.current = true

    const storedMode = localStorage.getItem('ai-mode')
    const storedScores = localStorage.getItem('ai-show-scores')
    if (!storedMode && !storedScores) return

    const fields: Record<string, unknown> = {}
    if (storedMode === 'off') {
      setAiMode('off')
      fields.ai_mode = 'off'
    } else if (
      storedMode === 'on' ||
      storedMode === 'bubble' ||
      storedMode === 'insight' ||
      storedMode === 'insights'
    ) {
      // Legacy migration: map all non-off values to 'on'
      setAiMode('on')
      fields.ai_mode = 'on'
    }
    if (storedScores !== null) {
      const val = storedScores !== 'false'
      setAiShowScores(val)
      fields.ai_show_scores = val
    }

    if (Object.keys(fields).length > 0) patchPreference(fields)
    localStorage.removeItem('ai-mode')
    localStorage.removeItem('ai-show-scores')
  }, [setAiMode, setAiShowScores])

  const setMode = useCallback(
    (mode: AiMode) => {
      setAiMode(mode)
      patchPreference({ ai_mode: mode })
    },
    [setAiMode],
  )

  const setShowInsights = useCallback(
    (show: boolean) => {
      setAiShowInsights(show)
      patchPreference({ ai_show_insights: show })
    },
    [setAiShowInsights],
  )

  const setWnCommentaryUnfiltered = useCallback(
    (show: boolean) => {
      setAiWnCommentaryUnfiltered(show)
      patchPreference({ ai_wn_commentary_unfiltered: show })
    },
    [setAiWnCommentaryUnfiltered],
  )

  const setWnHighlight = useCallback(
    (show: boolean) => {
      setAiWnHighlight(show)
      patchPreference({ ai_wn_highlight: show })
    },
    [setAiWnHighlight],
  )

  const setInsightsSignalChips = useCallback(
    (show: boolean) => {
      setAiInsightsSignalChips(show)
      patchPreference({ ai_insights_signal_chips: show })
    },
    [setAiInsightsSignalChips],
  )

  const setInsightsScoreChips = useCallback(
    (show: boolean) => {
      setAiInsightsScoreChips(show)
      patchPreference({ ai_insights_score_chips: show })
    },
    [setAiInsightsScoreChips],
  )

  return {
    mode: aiMode,
    setMode,
    showInsights: aiShowInsights,
    setShowInsights,
    wnCommentaryUnfiltered: aiWnCommentaryUnfiltered,
    setWnCommentaryUnfiltered,
    wnHighlight: aiWnHighlight,
    setWnHighlight,
    insightsSignalChips: aiInsightsSignalChips,
    setInsightsSignalChips,
    insightsScoreChips: aiInsightsScoreChips,
    setInsightsScoreChips,
  }
}
