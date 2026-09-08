'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Label } from '@/core/labels'

/**
 * The user's domain labels, for a picker (REDESIGN-V03 §7.2).
 *
 * Only the DOMAIN facet: those carry meaning ("kids", "health", "house") and
 * are the ones a person files something under. The `operational` facet is the
 * `ai-*` machinery — provenance and processing state — which nothing should be
 * able to hand-assign from a picker, so it is filtered out here rather than at
 * every call site.
 *
 * The registry is the source, not `label_config`: that preference only says
 * which labels have a COLOUR, so a label the user never coloured would be
 * missing from the list. Colour still comes from `label_config` at render time.
 *
 * Fetched once per mount, like `useTimeSlots` — a label registry changes about
 * as often as a time slot does. `reload` exists for the one moment it does
 * change under us: registering a new label as part of a save.
 *
 * A failure returns an empty list rather than throwing. The editor then offers
 * "none" and typing a new name, which is degraded but still usable; a throw
 * would take the whole editor down over what is a list of suggestions.
 */
export function useDomainLabels(): { labels: string[]; reload: () => void } {
  const [labels, setLabels] = useState<string[]>([])
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    fetch('/api/labels')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return
        const rows = (json?.data?.labels ?? []) as Label[]
        setLabels(rows.filter((l) => l.facet === 'domain').map((l) => l.name))
      })
      .catch(() => {
        if (!cancelled) setLabels([])
      })

    return () => {
      cancelled = true
    }
  }, [nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return { labels, reload }
}
