'use client'

import { useEffect, useState } from 'react'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The user's time slots, fetched when a menu or picker opens and kept for the session.
 *
 * Not `useTimeSlots`: every task row mounts its own `SnoozeMenu`, and that
 * hook fetches on mount — one request per row, for a menu most rows never
 * open. Here nothing is fetched until a menu opens; the first open shows the
 * slots as soon as they arrive, and every later one starts from the cache
 * while it refreshes (slots are rarely edited, but they can be).
 */
let slotCache: TimeSlot[] = []
export function useSlotsWhenOpen(open: boolean): TimeSlot[] {
  const [slots, setSlots] = useState<TimeSlot[]>(slotCache)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/time-slots')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const fresh = json?.data?.time_slots as TimeSlot[] | undefined
        if (!fresh) return
        slotCache = fresh
        if (!cancelled) setSlots(fresh)
      })
      // A failed fetch keeps whatever was cached: the fixed options still work.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])
  return slots
}
