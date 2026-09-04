'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Task } from '@/types'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { showToast } from '@/lib/toast'
import { summarizeReminders, type RemindersSummary } from '@/lib/reminders-summary'

/**
 * Today's reminders, grouped by time slot (REDESIGN-V03 §6).
 *
 * The server owns both the grouping and the within-slot ordering, so this hook
 * deliberately does no sorting: §6's "priority is prominence" is expressed as
 * position, and position is decided once, server-side, rather than being
 * re-derived by every surface that renders it.
 */
export interface ReminderGroup {
  slot: TimeSlot | null
  reminders: Task[]
  count: number
  /** Considered today in this slot (progress, §6). */
  considered: number
}

interface UseRemindersOptions {
  /** Undo the last action — wired to the completion toast. */
  onUndo: () => void
  /**
   * Called after a reminder is completed. The page uses this to keep its own
   * undo counter in step; completion here goes through the ordinary /done
   * endpoint, so it produces an ordinary undo entry.
   */
  onCompleted?: () => void
}

export interface UseRemindersReturn {
  groups: ReminderGroup[]
  total: number
  /**
   * Whether the user has any reminders at all, today or otherwise. Only the empty
   * state uses it — see `hasAnyReminders` in `@/core/tasks/reminders`.
   */
  hasAny: boolean
  loading: boolean
  error: string | null
  /** IDs mid-completion — the row is animating out while the request is in flight. */
  completingIds: Set<number>
  /** True once anything has been completed on this surface in this session. */
  consideredAny: boolean
  complete: (task: Task) => Promise<void>
  /**
   * Complete ("consider") a set of reminders at once — a selection made on the
   * surface, or a whole slot. One bulk call, one undo entry.
   */
  completeMany: (tasks: Task[]) => Promise<void>
  /**
   * Complete every reminder in one slot with a single tap — the container-level
   * gesture the design record calls "my task is to do my reminders".
   */
  completeGroup: (group: ReminderGroup) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Last successful payload, module-scoped so a revisit to the Reminders surface
 * paints instantly from memory while a background refresh reconciles
 * (stale-while-revalidate). Survives client-side navigation only — sign-out
 * goes through a full page load, which resets module state, so one user's
 * cache cannot leak into another's session.
 */
let remindersCache: { groups: ReminderGroup[]; hasAny: boolean } | null = null

// Anyone showing a number derived from the cache (the nav badge) subscribes
// here and re-renders whenever the surface refreshes or completes something.
const cacheListeners = new Set<() => void>()
function setRemindersCache(next: typeof remindersCache) {
  remindersCache = next
  for (const listener of cacheListeners) listener()
}

export function useReminders({ onUndo, onCompleted }: UseRemindersOptions): UseRemindersReturn {
  const [groups, setGroups] = useState<ReminderGroup[]>(remindersCache?.groups ?? [])
  const [hasAny, setHasAny] = useState(remindersCache?.hasAny ?? false)
  const [loading, setLoading] = useState(remindersCache === null)
  const [error, setError] = useState<string | null>(null)
  const [completingIds, setCompletingIds] = useState<Set<number>>(new Set())
  const [consideredAny, setConsideredAny] = useState(false)

  // Callbacks live in a ref so `refresh` and `complete` stay referentially
  // stable — the parent registers `refresh` in a ref and calls it from its own
  // refresh chain, and an identity that changed every render would make that
  // registration a moving target.
  const callbacksRef = useRef({ onUndo, onCompleted })
  callbacksRef.current = { onUndo, onCompleted }

  // IDs whose completion request is still in flight. A background refresh
  // (sync stream, undo chain) can land BETWEEN the optimistic removal and the
  // server recording the completion; the payload it brings still contains the
  // row, and re-inserting it produced an invisible gap (the row re-rendered in
  // its "completing" state and stayed). Any refresh strips these first.
  const pendingIdsRef = useRef<Set<number>>(new Set())
  const stripPending = (incoming: ReminderGroup[]): ReminderGroup[] => {
    const pending = pendingIdsRef.current
    if (pending.size === 0) return incoming
    return incoming.map((g) => {
      const remaining = g.reminders.filter((r) => !pending.has(r.id))
      return remaining.length === g.reminders.length
        ? g
        : { ...g, reminders: remaining, count: remaining.length }
    })
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) throw new Error('Failed to load reminders')
      const json = await res.json()
      const nextGroups = stripPending((json?.data?.groups ?? []) as ReminderGroup[])
      const nextHasAny = json?.data?.has_any === true
      setRemindersCache({ groups: nextGroups, hasAny: nextHasAny })
      setGroups(nextGroups)
      setHasAny(nextHasAny)
      setError(null)
    } catch (err) {
      // A failed background refresh over cached data is not an error state —
      // the stale render plus the next successful refresh beats an error
      // banner replacing content the user can already see.
      if (remindersCache === null) {
        setError(err instanceof Error ? err.message : 'Failed to load reminders')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Complete ("consider") a reminder.
   *
   * Routed through the ordinary POST /api/tasks/:id/done so completion, undo,
   * webhooks and recurrence advance behave exactly as they do for a task —
   * §6 changes what a reminder LOOKS like, not how completion works.
   *
   * OPTIMISTIC: the row leaves local state (and the toast fires) BEFORE the
   * server round trip — over a real network the round trip is what made
   * check-off feel frozen. A FAILED call restores the snapshot taken before
   * removal, so the item honestly reappears; same failure semantics as the
   * widget's tombstones (§8).
   */
  /**
   * Consider one or more reminders. One call, one undo entry — POST /done for
   * a single item, POST /bulk/done for several — so the toast's Undo restores
   * everything it removed.
   *
   * OPTIMISTIC, in both directions: the rows leave and the toast appears at
   * once. The toast's Undo is safe to press before the server has answered:
   * it waits for this request to settle first, so it can never undo whatever
   * action came before. (Offering Undo only after the round trip was the old
   * rule; over a real network that read as a frozen half-second between the
   * tap and any acknowledgement.) A failed call restores the snapshot and
   * turns the toast's promise into a no-op.
   */
  const completeIds = useCallback(
    async (tasks: Task[], message: string) => {
      const ids = tasks.map((t) => t.id)
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (const id of ids) pendingIdsRef.current.add(id)
      setCompletingIds((prev) => new Set([...prev, ...ids]))
      let snapshot: ReminderGroup[] | null = null
      setGroups((prev) => {
        snapshot = prev
        const next = prev.map((g) => {
          const remaining = g.reminders.filter((r) => !idSet.has(r.id))
          return remaining.length === g.reminders.length
            ? g
            : { ...g, reminders: remaining, count: remaining.length }
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
        return next
      })
      setConsideredAny(true)

      const request = (async () => {
        const res =
          ids.length === 1
            ? await fetch(`/api/tasks/${ids[0]}/done`, { method: 'POST' })
            : await fetch('/api/tasks/bulk/done', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
              })
        if (!res.ok) throw new Error('Failed to complete reminders')
        callbacksRef.current.onCompleted?.()
      })()

      // Undo waits for the completion to be recorded, then undoes exactly it.
      let settledOk = false
      showToast({
        message,
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            void request.then(() => callbacksRef.current.onUndo()).catch(() => undefined)
          },
        },
      })

      try {
        await request
        settledOk = true
      } catch {
        if (snapshot) {
          const restored = snapshot
          if (remindersCache) setRemindersCache({ ...remindersCache, groups: restored })
          setGroups(restored)
        }
        showToast({ message: 'Could not complete reminders', type: 'error' })
      } finally {
        for (const id of ids) pendingIdsRef.current.delete(id)
        setCompletingIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
        // A refresh after a confirmed completion converges the cache with the
        // server (the recurring case: a considered reminder is gone until its next
        // occurrence, which only the server knows).
        if (settledOk) void refresh()
      }
    },
    [refresh],
  )

  const completeMany = useCallback(
    (tasks: Task[]) => completeIds(tasks, `Considered ${tasks.length}`),
    [completeIds],
  )

  const complete = useCallback(
    (task: Task) => completeIds([task], `Considered \u201c${task.title}\u201d`),
    [completeIds],
  )

  const completeGroup = useCallback(
    (group: ReminderGroup) => completeMany(group.reminders),
    [completeMany],
  )

  const total = groups.reduce((sum, group) => sum + group.reminders.length, 0)

  return {
    groups,
    total,
    hasAny,
    loading,
    error,
    completingIds,
    consideredAny,
    complete,
    completeMany,
    completeGroup,
    refresh,
  }
}

/**
 * One fetch for everyone. The sidebar, the tab bar and the Reminders top bar
 * all read the cache and all mount at once, so without this each would fire
 * its own `/api/reminders` on the same tick. Concurrent callers share the
 * in-flight request; the next call after it settles starts a fresh one.
 */
let cacheLoad: Promise<void> | null = null
function loadRemindersCache(): Promise<void> {
  if (cacheLoad) return cacheLoad
  cacheLoad = (async () => {
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) return
      const json = await res.json()
      setRemindersCache({
        groups: (json?.data?.groups ?? []) as ReminderGroup[],
        hasAny: json?.data?.has_any === true,
      })
    } catch {
      // A badge that stays at its last value beats one that flickers.
    } finally {
      cacheLoad = null
    }
  })()
  return cacheLoad
}

/**
 * The day's numbers (waiting so far, later, considered) for the nav badge and
 * the Reminders top bar, read from the shared cache.
 *
 * Fetches once when nothing is cached, then re-derives whenever the Reminders
 * surface refreshes or completes something (same cache), and re-fetches when
 * the tab regains focus so a stale count never survives a trip away from the
 * app. Deliberately does NOT open its own sync stream — the navs are mounted
 * everywhere, and one EventSource per hook instance would multiply
 * connections; the surface's own stream keeps the cache honest while it is
 * open, and focus covers the rest.
 */
function subscribeToCache(listener: () => void) {
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
  }
}
const readCache = () => remindersCache
const readServerCache = () => null

export function useRemindersSummary(timezone: string): RemindersSummary<ReminderGroup> | null {
  // useSyncExternalStore rather than a force-render counter: the cache is
  // module state, and a render that reads it directly is invisible to the
  // React Compiler, which memoises the derived summary on `timezone` alone and
  // leaves every subscriber stuck at its first (empty) value. As a store
  // snapshot it is a real render input, so the summary recomputes when it
  // changes and only then.
  const cache = useSyncExternalStore(subscribeToCache, readCache, readServerCache)
  useEffect(() => {
    if (remindersCache === null) void loadRemindersCache()
    const onFocus = () => void loadRemindersCache()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return cache ? summarizeReminders(cache.groups, timezone) : null
}

/** The nav badge number: reminders waiting in slots that have started, plus Anytime. */
export function useRemindersBadge(timezone: string): number {
  return useRemindersSummary(timezone)?.waitingSoFar ?? 0
}
