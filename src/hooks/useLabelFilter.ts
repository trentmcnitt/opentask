'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  EMPTY_LABEL_FILTER,
  excludeLabelIn,
  exclusiveLabelIn,
  labelFilterCount,
  parseStoredLabelFilter,
  toggleLabelIn,
  type LabelFilterCriteria,
} from '@/lib/label-filter'

/**
 * A label filter that outlives a reload — the Quotas page's label chips
 * (2026-10-24). The chips, their gestures and what a selection means are the
 * dashboard's own (`LabelFilterBar`, src/lib/label-filter.ts); this hook is
 * only where the selection is kept.
 *
 * PERSISTED IN THIS BROWSER, unlike the dashboard's. The dashboard's chip
 * selection is session state (`useFilterState`, plain `useState`) and is gone
 * on a reload; only its section's open/shut is saved (`filters_expanded`, a
 * server preference). A quota label filter is a standing lens — "just the
 * kids ones" — so it is kept, under its own `storageKey`, as JSON
 * `{ selectedLabels, excludedLabels }`. localStorage, not a server
 * preference: the preferences response is part of the native apps' contract
 * (tests/fixtures/contract), and a per-device lens does not need to follow
 * the user to the phone. Every access is wrapped — storage can be empty,
 * blocked or throw, and the page then simply starts unfiltered.
 *
 * A kept filter is never invisible: the chips are always on screen on
 * /quotas, and `QuotasSummary` puts the dashboard's "Showing N of M · Clear
 * filter" line above a filtered list. A kept label that no quota carries any
 * more still has its chip (at 0), so it can always be turned off.
 */
export function useLabelFilter(storageKey: string) {
  const [criteria, setCriteria] = useState<LabelFilterCriteria>(() => readStored(storageKey))

  useEffect(() => {
    writeStored(storageKey, criteria)
  }, [storageKey, criteria])

  const toggleLabel = useCallback((label: string) => {
    setCriteria((c) => toggleLabelIn(c, label))
  }, [])
  const excludeLabel = useCallback((label: string) => {
    setCriteria((c) => excludeLabelIn(c, label))
  }, [])
  const exclusiveLabel = useCallback((label: string) => {
    setCriteria((c) => exclusiveLabelIn(c, label))
  }, [])
  const clearLabels = useCallback(() => setCriteria(EMPTY_LABEL_FILTER), [])

  const activeCount = labelFilterCount(criteria)

  return { criteria, activeCount, toggleLabel, excludeLabel, exclusiveLabel, clearLabels }
}

function readStored(key: string): LabelFilterCriteria {
  if (typeof window === 'undefined') return EMPTY_LABEL_FILTER
  try {
    return parseStoredLabelFilter(window.localStorage.getItem(key))
  } catch {
    return EMPTY_LABEL_FILTER
  }
}

function writeStored(key: string, c: LabelFilterCriteria): void {
  try {
    if (labelFilterCount(c) === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(c))
  } catch {
    // Storage unavailable: the filter works for this visit and is not kept.
  }
}
