'use client'

import { useEffect, useState } from 'react'
import { useAiAvailable, useAiFeatureInfo } from '@/components/PreferencesProvider'
import type { FeatureInfoMap } from '@/components/PreferencesProvider'

interface SlotStatus {
  state?: string
}

interface AiStatusData {
  enrichment_slot?: SlotStatus
  quick_take_slot?: SlotStatus
}

/**
 * The worst warm-slot state across the features that run in SDK mode.
 *
 * 'uninitialized' is left out: it means the warm slot is deliberately off and
 * the feature runs on the cold path, which is not an error. With nothing left,
 * the answer is 'unknown' (the grey dot).
 */
function worstSlotState(data: AiStatusData, featureInfo: FeatureInfoMap | null): string {
  const states: string[] = []
  const add = (slot: SlotStatus | undefined, sdk: boolean) => {
    if (sdk && slot?.state && slot.state !== 'uninitialized') states.push(slot.state)
  }
  add(data.enrichment_slot, featureInfo?.enrichment?.mode === 'sdk')
  add(data.quick_take_slot, featureInfo?.quick_take?.mode === 'sdk')
  // Priority: dead > initializing > busy > available
  return (
    states.find((s) => s === 'dead') ??
    states.find((s) => s === 'initializing') ??
    states.find((s) => s === 'busy') ??
    states[0] ??
    'unknown'
  )
}

/**
 * State for the AI status dot (`AIStatusDot`) — shared by the top bar's menu
 * and the dashboard's AI popover, which used to fetch `/api/ai/status` each
 * their own way and could disagree (the popover showed a red dot for a warm
 * slot that was merely switched off).
 *
 * The dot only means something when AI runs on this server and at least one
 * feature uses SDK mode (API mode has no warm slot), so the hook returns
 * `null` — no dot — otherwise. `enabled` says when to look: the status is
 * fetched once, the first time `enabled` is true, and kept after that (the
 * top bar passes "the menu is open", so it asks only when someone looks).
 * A 503 means AI is off server-side ('disabled', which callers don't draw); any
 * other failure is 'unknown'.
 */
export function useAiSlotState({ enabled }: { enabled: boolean }): string | null {
  const aiAvailable = useAiAvailable()
  const { aiFeatureInfo } = useAiFeatureInfo()
  const hasSdkFeature = aiFeatureInfo
    ? Object.values(aiFeatureInfo).some((f) => f.mode === 'sdk')
    : false
  const shouldFetch = enabled && aiAvailable && hasSdkFeature
  const [state, setState] = useState<string | null>(null)
  const fetched = state !== null

  useEffect(() => {
    if (!shouldFetch || fetched) return
    let cancelled = false
    fetch('/api/ai/status')
      .then((res) => {
        if (res.status === 503) return 'disabled'
        if (!res.ok) return 'unknown'
        return res
          .json()
          .then((json: { data?: AiStatusData }) =>
            json?.data ? worstSlotState(json.data, aiFeatureInfo) : 'unknown',
          )
      })
      .catch(() => 'unknown')
      .then((next) => {
        if (!cancelled) setState(next)
      })
    return () => {
      cancelled = true
    }
  }, [shouldFetch, fetched, aiFeatureInfo])

  return aiAvailable && hasSdkFeature ? state : null
}
