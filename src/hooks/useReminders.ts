'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@/types'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { showToast } from '@/lib/toast'

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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) throw new Error('Failed to load reminders')
      const json = await res.json()
      const nextGroups = (json?.data?.groups ?? []) as ReminderGroup[]
      const nextHasAny = json?.data?.has_any === true
      remindersCache = { groups: nextGroups, hasAny: nextHasAny }
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
  const complete = useCallback(async (task: Task) => {
    setCompletingIds((prev) => new Set(prev).add(task.id))
    let snapshot: ReminderGroup[] | null = null
    setGroups((prev) => {
      snapshot = prev
      const next = prev.map((group) => {
        const remaining = group.reminders.filter((r) => r.id !== task.id)
        return remaining.length === group.reminders.length
          ? group
          : { ...group, reminders: remaining, count: remaining.length }
      })
      if (remindersCache) remindersCache = { ...remindersCache, groups: next }
      return next
    })
    setConsideredAny(true)
    try {
      const res = await fetch(`/api/tasks/${task.id}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to complete reminder')
      // Toast (and the undo counter) only after the server has recorded the
      // completion: an Undo offered before that would undo whatever action
      // preceded this one. The row vanishing above is the instant feedback;
      // the toast trailing it by the round trip is imperceptible.
      callbacksRef.current.onCompleted?.()
      showToast({
        message: 'Considered',
        type: 'success',
        action: { label: 'Undo', onClick: () => callbacksRef.current.onUndo() },
      })
    } catch {
      if (snapshot) {
        const restored = snapshot
        if (remindersCache) remindersCache = { ...remindersCache, groups: restored }
        setGroups(restored)
      }
      showToast({ message: 'Could not complete reminder', type: 'error' })
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }, [])

  /**
   * Consider several reminders at once via POST /api/tasks/bulk/done, which
   * logs ONE `bulk_done` undo entry — so the toast's Undo restores every row
   * together, not one at a time. Same optimistic contract as `complete`: the
   * rows leave immediately, and a failed call restores the snapshot.
   */
  const completeMany = useCallback(async (tasks: Task[]) => {
    const ids = tasks.map((t) => t.id)
    if (ids.length === 0) return
    const idSet = new Set(ids)
    setCompletingIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    let snapshot: ReminderGroup[] | null = null
    setGroups((prev) => {
      snapshot = prev
      const next = prev.map((g) => {
        const remaining = g.reminders.filter((r) => !idSet.has(r.id))
        return remaining.length === g.reminders.length
          ? g
          : { ...g, reminders: remaining, count: remaining.length }
      })
      if (remindersCache) remindersCache = { ...remindersCache, groups: next }
      return next
    })
    setConsideredAny(true)
    try {
      const res = await fetch('/api/tasks/bulk/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error('Failed to complete reminders')
      callbacksRef.current.onCompleted?.()
      showToast({
        message: ids.length === 1 ? 'Considered' : `Considered ${ids.length}`,
        type: 'success',
        action: { label: 'Undo', onClick: () => callbacksRef.current.onUndo() },
      })
    } catch {
      if (snapshot) {
        const restored = snapshot
        if (remindersCache) remindersCache = { ...remindersCache, groups: restored }
        setGroups(restored)
      }
      showToast({ message: 'Could not complete reminders', type: 'error' })
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }
  }, [])

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
