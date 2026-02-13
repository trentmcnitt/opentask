'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAiPreferences } from '@/components/PreferencesProvider'

export type AiMode = 'off' | 'on'

export interface UseAiModeReturn {
  mode: AiMode
  setMode: (mode: AiMode) => void
  showScores: boolean
  setShowScores: (show: boolean) => void
  showSignals: boolean
  setShowSignals: (show: boolean) => void
  showBubbleText: boolean
  setShowBubbleText: (show: boolean) => void
  showInsights: boolean
  setShowInsights: (show: boolean) => void
  showCommentary: boolean
  setShowCommentary: (show: boolean) => void
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
 * Manages AI mode toggle state (Off / Bubble / Insights), sub-feature checkboxes
 * (Scores, Signals, Bubble text, Commentary). Backed by PreferencesProvider
 * (server-persisted per user).
 *
 * On first load, migrates any leftover localStorage keys to the server
 * and deletes them.
 */
export function useAiMode(): UseAiModeReturn {
  const {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowBubbleText,
    setAiShowBubbleText,
    aiShowInsights,
    setAiShowInsights,
    aiShowCommentary,
    setAiShowCommentary,
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

  const setShowScores = useCallback(
    (show: boolean) => {
      setAiShowScores(show)
      patchPreference({ ai_show_scores: show })
    },
    [setAiShowScores],
  )

  const setShowSignals = useCallback(
    (show: boolean) => {
      setAiShowSignals(show)
      patchPreference({ ai_show_signals: show })
    },
    [setAiShowSignals],
  )

  const setShowBubbleText = useCallback(
    (show: boolean) => {
      setAiShowBubbleText(show)
      patchPreference({ ai_show_bubble_text: show })
    },
    [setAiShowBubbleText],
  )

  const setShowInsights = useCallback(
    (show: boolean) => {
      setAiShowInsights(show)
      patchPreference({ ai_show_insights: show })
    },
    [setAiShowInsights],
  )

  const setShowCommentary = useCallback(
    (show: boolean) => {
      setAiShowCommentary(show)
      patchPreference({ ai_show_commentary: show })
    },
    [setAiShowCommentary],
  )

  return {
    mode: aiMode,
    setMode,
    showScores: aiShowScores,
    setShowScores,
    showSignals: aiShowSignals,
    setShowSignals,
    showBubbleText: aiShowBubbleText,
    setShowBubbleText,
    showInsights: aiShowInsights,
    setShowInsights,
    showCommentary: aiShowCommentary,
    setShowCommentary,
  }
}
