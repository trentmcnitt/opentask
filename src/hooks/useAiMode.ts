'use client'

import { useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useAiFeatureInfo, useAiPreferences } from '@/components/PreferencesProvider'
import type { FeatureInfoMap, FeatureMode } from '@/components/PreferencesProvider'
import { savePreference } from '@/lib/save-preference'

export type AiMode = 'off' | 'on'

export interface UseAiModeReturn {
  mode: AiMode
  setMode: (mode: AiMode) => void
  /** Whether insights are enabled (insights mode !== 'off') */
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

/**
 * Save one AI preference: show it at once, and put `prev` back (with an error
 * toast) if the save fails. Quiet on success — the switch is the feedback.
 */
function saveQuietly<T>(field: string, value: T, prev: T, setter: (v: T) => void) {
  return savePreference(
    { [field]: value },
    { apply: () => setter(value), revert: () => setter(prev), successMessage: null },
  )
}

/**
 * Manages AI mode toggle state (Off / On) and visibility preferences:
 * - Insights visibility is derived from insights mode (off = hidden, sdk/api = shown)
 * - WN commentary when not filtering, WN background highlight
 * - Signal/score chip visibility
 *
 * Backed by PreferencesProvider (server-persisted per user). Each setter saves
 * through `savePreference` quietly: optimistic, rolled back with an error toast
 * if the save fails. Turning Insights on or off also refreshes
 * `aiFeatureInfo` from the response, as Settings → AI does, so the AI status
 * views see the new mode without a reload.
 *
 * The demo account may not change `ai_mode` or `ai_insights_mode` (the
 * preferences route answers 403), so for it those two switches stay local to
 * the page, as they always have: saving them would only fail, snap back and
 * toast an error at a visitor trying the switch.
 */
export function useAiMode(): UseAiModeReturn {
  const {
    aiMode,
    setAiMode,
    aiInsightsMode,
    setAiInsightsMode,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
  } = useAiPreferences()
  const { setAiFeatureInfo } = useAiFeatureInfo()
  const isDemo = useSession().data?.user?.is_demo ?? false

  const setMode = useCallback(
    (mode: AiMode) => {
      if (isDemo) setAiMode(mode)
      else void saveQuietly('ai_mode', mode, aiMode, setAiMode)
    },
    [isDemo, aiMode, setAiMode],
  )

  // Insights visibility: derived from ai_insights_mode.
  // Toggle sets mode between 'off' and 'api'.
  const showInsights = aiInsightsMode !== 'off'

  const setShowInsights = useCallback(
    (show: boolean) => {
      const newMode: FeatureMode = show ? 'api' : 'off'
      if (isDemo) {
        setAiInsightsMode(newMode)
        return
      }
      const prev = aiInsightsMode
      void savePreference<{ ai_feature_info?: FeatureInfoMap }>(
        { ai_insights_mode: newMode },
        {
          apply: () => setAiInsightsMode(newMode),
          revert: () => setAiInsightsMode(prev),
          successMessage: null,
        },
      ).then((data) => {
        if (data?.ai_feature_info) setAiFeatureInfo(data.ai_feature_info)
      })
    },
    [isDemo, aiInsightsMode, setAiInsightsMode, setAiFeatureInfo],
  )

  const setWnCommentaryUnfiltered = useCallback(
    (show: boolean) => {
      void saveQuietly(
        'ai_wn_commentary_unfiltered',
        show,
        aiWnCommentaryUnfiltered,
        setAiWnCommentaryUnfiltered,
      )
    },
    [aiWnCommentaryUnfiltered, setAiWnCommentaryUnfiltered],
  )

  const setWnHighlight = useCallback(
    (show: boolean) => {
      void saveQuietly('ai_wn_highlight', show, aiWnHighlight, setAiWnHighlight)
    },
    [aiWnHighlight, setAiWnHighlight],
  )

  const setInsightsSignalChips = useCallback(
    (show: boolean) => {
      void saveQuietly(
        'ai_insights_signal_chips',
        show,
        aiInsightsSignalChips,
        setAiInsightsSignalChips,
      )
    },
    [aiInsightsSignalChips, setAiInsightsSignalChips],
  )

  const setInsightsScoreChips = useCallback(
    (show: boolean) => {
      void saveQuietly(
        'ai_insights_score_chips',
        show,
        aiInsightsScoreChips,
        setAiInsightsScoreChips,
      )
    },
    [aiInsightsScoreChips, setAiInsightsScoreChips],
  )

  return {
    mode: aiMode,
    setMode,
    showInsights,
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
