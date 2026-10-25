'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The user's time slots (REDESIGN-V03 §6.0) — ONE shared list for the page.
 *
 * SHARED, STALE-WHILE-REVALIDATE (2026-10-24, relative targets: the task
 * editor reads the periods every time it opens, and latency is the top
 * irritation): the last list read is module state, so every surface and every
 * editor paints from it at once. Like `useReminders`' cache:
 *  - a page that server-rendered the list (`initial`: the Tasks page ships its
 *    slots with its tasks, so the first paint is already grouped by slot)
 *    seeds it, and nothing is fetched up front;
 *  - with nothing held, the first mount fetches — concurrent mounts share the
 *    one request (`loadTimeSlots`);
 *  - with a list held, a SURFACE (the default, `revalidate: true`) paints it
 *    and re-reads in the background; the task EDITOR (`revalidate: false`)
 *    just reads it — opening the editor twice costs no request, or one on a
 *    page that had none;
 *  - `refresh()` re-reads it for everyone: surfaces call it from their
 *    sync-stream handler (a slot edit emits a sync event and moves reminders
 *    with it) and Settings after each period edit, so the shared list follows
 *    both.
 * Sign-out is a full page load, which resets module state, so one user's list
 * never leaks into another's session. Nothing is written on the server (module
 * state there is shared by every request).
 *
 * Failure returns an empty array rather than throwing. An empty slot list
 * leaves the surfaces that group by period with one un-slotted group, which is
 * a degraded but honest view; a thrown error would take down the whole
 * dashboard over what is effectively presentation metadata. A failed REFRESH
 * keeps the slots already held rather than blanking them.
 */

interface Store {
  /** The last list read (or seeded); null before any succeeded. */
  slots: TimeSlot[] | null
  /** A first read has finished, succeeded or not. */
  settled: boolean
}

const EMPTY: Store = { slots: null, settled: false }
let store: Store = EMPTY
const listeners = new Set<() => void>()

function setStore(next: Store) {
  store = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const readStore = () => store
const readServerStore = () => EMPTY

/** One request at a time: concurrent callers share the one in flight. */
let inflight: Promise<void> | null = null
function loadTimeSlots(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/time-slots')
      const json = res.ok ? await res.json() : null
      const list = json?.data?.time_slots
      if (Array.isArray(list)) setStore({ slots: list, settled: true })
      else if (!store.settled) setStore({ ...store, settled: true })
    } catch {
      // Keep what we have — see the header.
      if (!store.settled) setStore({ ...store, settled: true })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** A server-rendered list becomes the shared one (only when it differs). */
function seedTimeSlots(list: TimeSlot[]) {
  if (typeof window === 'undefined') return
  if (store.slots && JSON.stringify(store.slots) === JSON.stringify(list)) return
  setStore({ slots: list, settled: true })
}

export function useTimeSlots(
  initial?: TimeSlot[],
  { revalidate = true }: { revalidate?: boolean } = {},
): {
  timeSlots: TimeSlot[]
  loading: boolean
  /**
   * A read has SUCCEEDED (or the page shipped the list). False after a failed
   * first read, when `timeSlots` is the empty fallback — a surface that would
   * act on the list (Settings' anchor rows, which would show a linked time as
   * custom and then save it so) waits for this rather than `!loading`.
   */
  loaded: boolean
  refresh: () => Promise<void>
} {
  const snapshot = useSyncExternalStore(subscribe, readStore, readServerStore)

  useEffect(() => {
    if (initial !== undefined) {
      seedTimeSlots(initial)
      return
    }
    if (store.slots === null || revalidate) void loadTimeSlots()
  }, [initial, revalidate])

  const refresh = useCallback(() => loadTimeSlots(), [])
  const timeSlots = snapshot.slots ?? initial ?? []
  const loaded = snapshot.slots !== null || initial !== undefined
  return { timeSlots, loading: !loaded && !snapshot.settled, loaded, refresh }
}
