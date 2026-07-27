'use client'

import { useEffect, useState } from 'react'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The user's time slots (REDESIGN-V03 §6.0).
 *
 * Fetched once per mount. Slots change rarely — they're boundaries the user
 * configures, not data — so there's no polling and no revalidation on focus.
 *
 * Failure returns an empty array rather than throwing. An empty slot list makes
 * `groupByTimeSlot` put everything in "Anytime today", which is a degraded but
 * honest view; a thrown error would take down the whole dashboard over what is
 * effectively presentation metadata.
 */
export function useTimeSlots(): { timeSlots: TimeSlot[]; loading: boolean } {
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
  }, [])

  return { timeSlots, loading }
}
