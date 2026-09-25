'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The user's two quota-reminder settings (2026-09-24): the feature's on/off
 * switch and the period prompts go in by default (a time slot id; null = the
 * first period of the day). Settings edits them; the quota editor reads the
 * default so it can show where an unassigned prompt will actually land.
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
