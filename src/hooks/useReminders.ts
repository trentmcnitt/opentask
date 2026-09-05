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
  /** The considered ones, most recent first — shown behind the counter, each with a way back. */
  consideredItems: Task[]
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
  /** Reverse a consideration: the thought returns to waiting. */
  putBack: (task: Task) => Promise<void>
  /** Move reminders to Trash (soft delete), with Undo. */
  remove: (tasks: Task[]) => Promise<void>
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

/** The API speaks snake_case; the one place its reminder groups become ours. */
function parseGroups(json: unknown): ReminderGroup[] {
  const groups = (json as { data?: { groups?: unknown[] } })?.data?.groups ?? []
  return groups.map((raw) => {
    const g = raw as Omit<ReminderGroup, 'consideredItems'> & { considered_items?: Task[] }
    return {
      slot: g.slot,
      reminders: g.reminders ?? [],
      count: g.count ?? g.reminders?.length ?? 0,
      considered: g.considered ?? 0,
      consideredItems: g.considered_items ?? [],
    }
  })
}

/**
 * Apply what is still in flight to a payload the server just sent: ids being
 * considered leave `reminders` for `consideredItems`, ids being put back go
 * the other way. Without this a refresh landing mid-request re-inserted the
 * row in its old place (a visible gap, or a thought that flickered back).
 */
function reconcileInFlight(
  incoming: ReminderGroup[],
  pending: Set<number>,
  restoring: Set<number>,
): ReminderGroup[] {
  if (pending.size === 0 && restoring.size === 0) return incoming
  return incoming.map((g) => {
    const leaving = g.reminders.filter((r) => pending.has(r.id))
    const returning = g.consideredItems.filter((r) => restoring.has(r.id))
    if (leaving.length === 0 && returning.length === 0) return g
    const reminders = [...g.reminders.filter((r) => !pending.has(r.id)), ...returning]
    const consideredItems = [...leaving, ...g.consideredItems.filter((r) => !restoring.has(r.id))]
    return {
      ...g,
      reminders,
      count: reminders.length,
      consideredItems,
      considered: consideredItems.length,
    }
  })
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
  // The same in the other direction: a put-back whose request is still out.
  const pendingIdsRef = useRef<Set<number>>(new Set())
  const restoringIdsRef = useRef<Set<number>>(new Set())
  const stripPending = (incoming: ReminderGroup[]) =>
    reconcileInFlight(incoming, pendingIdsRef.current, restoringIdsRef.current)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) throw new Error('Failed to load reminders')
      const json = await res.json()
      const nextGroups = stripPending(parseGroups(json))
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
          if (remaining.length === g.reminders.length) return g
          const considered = g.reminders.filter((r) => idSet.has(r.id))
          // The considered ones move behind the counter at once, so the
          // progress and the "put back" list agree with the row that just left.
          const consideredItems = [...considered, ...g.consideredItems]
          return {
            ...g,
            reminders: remaining,
            count: remaining.length,
            consideredItems,
            considered: consideredItems.length,
          }
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

  const putBack = usePutBack({ setGroups, refresh, restoringIdsRef, callbacksRef })
  const remove = useRemove({ setGroups, refresh, pendingIdsRef, callbacksRef })

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
    putBack,
    remove,
    refresh,
  }
}

/**
 * Trash one or more reminders (POST /api/tasks/bulk/delete — a soft delete,
 * one undo entry). Trent (2026-09-05): the surface had no way to get rid of a
 * reminder. Same optimistic shape as considering: the rows leave at once,
 * the toast's Undo waits for the request, a failure restores the snapshot.
 * The ids ride in `pendingIdsRef` so a refresh landing mid-request does not
 * re-insert them.
 */
function useRemove({
  setGroups,
  refresh,
  pendingIdsRef,
  callbacksRef,
}: {
  setGroups: React.Dispatch<React.SetStateAction<ReminderGroup[]>>
  refresh: () => Promise<void>
  pendingIdsRef: React.MutableRefObject<Set<number>>
  callbacksRef: React.MutableRefObject<UseRemindersOptions>
}) {
  return useCallback(
    async (tasks: Task[]) => {
      const ids = tasks.map((t) => t.id)
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (const id of ids) pendingIdsRef.current.add(id)
      let snapshot: ReminderGroup[] | null = null
      setGroups((prev) => {
        snapshot = prev
        const next = prev.map((g) => {
          const reminders = g.reminders.filter((r) => !idSet.has(r.id))
          const consideredItems = g.consideredItems.filter((r) => !idSet.has(r.id))
          if (
            reminders.length === g.reminders.length &&
            consideredItems.length === g.consideredItems.length
          )
            return g
          return {
            ...g,
            reminders,
            count: reminders.length,
            consideredItems,
            considered: consideredItems.length,
          }
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
        return next
      })

      const request = (async () => {
        const res = await fetch('/api/tasks/bulk/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error('Failed to delete reminders')
        callbacksRef.current.onCompleted?.()
      })()

      let settledOk = false
      showToast({
        message:
          tasks.length === 1
            ? `Moved \u201c${tasks[0].title}\u201d to Trash`
            : `Moved ${tasks.length} reminders to Trash`,
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
        showToast({ message: 'Could not delete reminders', type: 'error' })
      } finally {
        for (const id of ids) pendingIdsRef.current.delete(id)
        if (settledOk) void refresh()
      }
    },
    [refresh, setGroups, pendingIdsRef, callbacksRef],
  )
}

/**
 * Put a considered thought back (POST /api/tasks/:id/undone — for a
 * recurring reminder that reverses the latest completion). Optimistic the
 * same way as considering: the row returns at once, the toast's Undo waits
 * for the request, a failure restores the snapshot.
 */
function usePutBack({
  setGroups,
  refresh,
  restoringIdsRef,
  callbacksRef,
}: {
  setGroups: React.Dispatch<React.SetStateAction<ReminderGroup[]>>
  refresh: () => Promise<void>
  restoringIdsRef: React.MutableRefObject<Set<number>>
  callbacksRef: React.MutableRefObject<UseRemindersOptions>
}) {
  return useCallback(
    async (task: Task) => {
      const id = task.id
      restoringIdsRef.current.add(id)
      let snapshot: ReminderGroup[] | null = null
      setGroups((prev) => {
        snapshot = prev
        const next = prev.map((g) => {
          if (!g.consideredItems.some((r) => r.id === id)) return g
          const consideredItems = g.consideredItems.filter((r) => r.id !== id)
          const reminders = [...g.reminders, task]
          return {
            ...g,
            reminders,
            count: reminders.length,
            consideredItems,
            considered: consideredItems.length,
          }
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
        return next
      })

      const request = (async () => {
        const res = await fetch(`/api/tasks/${id}/undone`, { method: 'POST' })
        if (!res.ok) throw new Error('Failed to put back')
        callbacksRef.current.onCompleted?.()
      })()

      let settledOk = false
      showToast({
        message: `Put back \u201c${task.title}\u201d`,
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
        showToast({ message: 'Could not put it back', type: 'error' })
      } finally {
        restoringIdsRef.current.delete(id)
        if (settledOk) void refresh()
      }
    },
    [refresh, setGroups, restoringIdsRef, callbacksRef],
  )
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
        groups: parseGroups(json),
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
