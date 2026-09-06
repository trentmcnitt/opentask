'use client'

import { useEffect, useState } from 'react'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The user's time slots (REDESIGN-V03 §6.0).
 *
 * Fetched once per mount, unless the page server-rendered them (`initial`),
 * in which case nothing is fetched: the Tasks page ships its slots with its
 * tasks so the first paint is already grouped by slot. Slots change rarely —
 * they're boundaries the user configures, not data — so there's no polling
 * and no revalidation on focus.
 *
 * Failure returns an empty array rather than throwing. An empty slot list makes
 * `groupByTimeSlot` put everything in one un-slotted group, which is a degraded but
 * honest view; a thrown error would take down the whole dashboard over what is
 * effectively presentation metadata.
 */
export function useTimeSlots(initial?: TimeSlot[]): { timeSlots: TimeSlot[]; loading: boolean } {
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

  return { timeSlots, loading }
}
