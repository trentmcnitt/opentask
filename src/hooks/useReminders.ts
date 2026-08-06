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
  refresh: () => Promise<void>
}

export function useReminders({ onUndo, onCompleted }: UseRemindersOptions): UseRemindersReturn {
  const [groups, setGroups] = useState<ReminderGroup[]>([])
  const [hasAny, setHasAny] = useState(false)
  const [loading, setLoading] = useState(true)
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
      setGroups((json?.data?.groups ?? []) as ReminderGroup[])
      setHasAny(json?.data?.has_any === true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reminders')
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
   * The row is marked completing first so it fades before the round trip
   * finishes, and is dropped from local state on success rather than waiting
   * for a refetch: §6 wants completed items out of the slot immediately so they
   * stop burying the ones still worth considering.
   */
  const complete = useCallback(async (task: Task) => {
    setCompletingIds((prev) => new Set(prev).add(task.id))
    try {
      const res = await fetch(`/api/tasks/${task.id}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to complete reminder')
      setGroups((prev) =>
        prev.map((group) => {
          const remaining = group.reminders.filter((r) => r.id !== task.id)
          return remaining.length === group.reminders.length
            ? group
            : { ...group, reminders: remaining, count: remaining.length }
        }),
      )
      setConsideredAny(true)
      callbacksRef.current.onCompleted?.()
      showToast({
        message: 'Considered',
        type: 'success',
        action: { label: 'Undo', onClick: () => callbacksRef.current.onUndo() },
      })
    } catch {
      showToast({ message: 'Could not complete reminder', type: 'error' })
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }, [])

  const total = groups.reduce((sum, group) => sum + group.reminders.length, 0)

  return { groups, total, hasAny, loading, error, completingIds, consideredAny, complete, refresh }
}
