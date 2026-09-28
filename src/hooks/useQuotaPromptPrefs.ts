'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The user's reminder-placement settings: the quota-reminders on/off switch
 * (2026-09-24) and the DEFAULT REMINDER SLOT (`slotId`, a time slot id; null =
 * the first period of the day). The slot began as where quota prompts go by
 * default and, since 2026-09-28, is where ANY reminder goes when nothing says
 * when (stored as `quota_prompt_slot_id`; see `defaultReminderSlot`).
 * Settings edits them; the quota editor reads the default so it can show where
 * an unassigned prompt will actually land, and the reminder editor reads it to
 * pre-pick a new reminder's slot.
 *
 * Module-cached like the other small settings reads, so opening a quota's
 * editor after Settings costs no fetch.
 */
export interface QuotaPromptPrefs {
  enabled: boolean
  slotId: number | null
}

let cache: QuotaPromptPrefs | null = null

export function useQuotaPromptPrefs(): {
  prefs: QuotaPromptPrefs | null
  save: (patch: Partial<QuotaPromptPrefs>) => Promise<void>
} {
  const [prefs, setPrefs] = useState<QuotaPromptPrefs | null>(cache)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/user/preferences')
        if (!res.ok) return
        const data = (await res.json()).data as {
          quota_prompts_enabled?: boolean
          quota_prompt_slot_id?: number | null
        }
        cache = {
          enabled: data.quota_prompts_enabled !== false,
          slotId: data.quota_prompt_slot_id ?? null,
        }
        if (!cancelled) setPrefs(cache)
      } catch {
        // Leave whatever was cached: the controls simply wait for it.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async (patch: Partial<QuotaPromptPrefs>) => {
    const body: Record<string, unknown> = {}
    if (patch.enabled !== undefined) body.quota_prompts_enabled = patch.enabled
    if (patch.slotId !== undefined) body.quota_prompt_slot_id = patch.slotId
    const res = await fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(err?.error || 'Could not save')
    }
    const data = (await res.json()).data as {
      quota_prompts_enabled: boolean
      quota_prompt_slot_id: number | null
    }
    cache = { enabled: data.quota_prompts_enabled, slotId: data.quota_prompt_slot_id }
    setPrefs(cache)
  }, [])

  return { prefs, save }
}
