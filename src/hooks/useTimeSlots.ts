'use client'

import { useCallback, useEffect, useState } from 'react'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The user's time slots (REDESIGN-V03 §6.0).
 *
 * Fetched once per mount, unless the page server-rendered them (`initial`),
 * in which case nothing is fetched up front: the Tasks page ships its slots
 * with its tasks so the first paint is already grouped by slot. Slots change
 * rarely — they're boundaries the user configures in Settings → Reminder
 * periods — so there's no polling and no revalidation on focus.
 *
 * `refresh()` re-reads them. Surfaces call it from their sync-stream handler:
 * a slot edit emits a sync event (and moves reminders with it), so a tab left
 * open on the dashboard regroups by the new boundaries instead of grouping
 * fresh tasks by stale ones.
 *
 * Failure returns an empty array rather than throwing. An empty slot list makes
 * `groupByTimeSlot` put everything in one un-slotted group, which is a degraded but
 * honest view; a thrown error would take down the whole dashboard over what is
 * effectively presentation metadata. A failed REFRESH keeps the slots already
 * held rather than blanking them.
 */
export function useTimeSlots(initial?: TimeSlot[]): {
  timeSlots: TimeSlot[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>(initial ?? [])
  const [loading, setLoading] = useState(initial === undefined)
  const hasInitial = initial !== undefined

  useEffect(() => {
    if (hasInitial) return
    let cancelled = false

    fetch('/api/time-slots')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return
        setTimeSlots(json?.data?.time_slots ?? [])
      })
      .catch(() => {
        if (!cancelled) setTimeSlots([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [hasInitial])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/time-slots')
      if (!res.ok) return
      const json = await res.json()
      if (Array.isArray(json?.data?.time_slots)) setTimeSlots(json.data.time_slots)
    } catch {
      // Keep what we have — see the header.
    }
  }, [])

  return { timeSlots, loading, refresh }
}
