'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { useAiAvailable, useAiContext, useAiPreferences } from '@/components/PreferencesProvider'
import { aiContextStaleness, type AiContextStaleness } from '@/lib/ai-context-staleness'

/**
 * The AI-context staleness warning's state for the left bar and the mobile
 * header menu, or null when there is nothing to show.
 *
 * Hidden when AI is off — off on this server (`aiAvailable`, which also stays
 * false until the preferences load) or switched off by the user (`aiMode`) —
 * and for the demo account, which can't edit its context (the preferences
 * route refuses `ai_context` for it), so a warning would point at a disabled
 * field.
 *
 * `now` is taken once per mount: the threshold is weeks, so a page left open
 * for a day is not going to miss anything that matters.
 */
export function useAiContextStaleness(): AiContextStaleness | null {
  const aiAvailable = useAiAvailable()
  const { aiMode } = useAiPreferences()
  const { aiContext, aiContextUpdatedAt } = useAiContext()
  const isDemo = useSession().data?.user?.is_demo ?? false
  const [now] = useState(() => new Date())
  if (!aiAvailable || aiMode === 'off' || isDemo) return null
  return aiContextStaleness(aiContext, aiContextUpdatedAt, now)
}
