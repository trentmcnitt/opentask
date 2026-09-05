'use client'

import { useRef, useState } from 'react'
import { periodLabel, trackState, type TrackState } from '@/lib/track'
import { showToast } from '@/lib/toast'
import type { Task } from '@/types'

/**
 * Logging on a tracked task (REDESIGN-V03 §5), optimistic and safe under
 * rapid taps.
 *
 * While any request is in flight the caller shows this hook's own running
 * count: each tap adjusts it at once, requests fire independently and the
 * server applies them in order. When the last request settles, the server's
 * answer is pinned until the task prop catches up — keyed to the prop value
 * it was pinned against, so a refetch (sync stream, undo) that brings a *new*
 * value replaces it and a stale one is ignored. That is what stops the count
 * dipping to an older value for a beat between a response and the refetch it
 * triggers. A failed request reverts its own delta and says so. Progress never
 * goes below zero — a correction can undo a mis-log, not manufacture history.
 *
 * Every log shows a toast with Undo (Trent, 2026-09-05): a slip on a chip is
 * one tap to take back, no gesture to learn. Undo is simply the opposite
 * delta, and is itself quiet — it does not spawn another toast. One toast per
 * task (keyed by id), so rapid taps update a line instead of stacking.
 */
export function useTrackProgress(task: Task): {
  state: TrackState
  period: string | null
  log: (delta: 1 | -1, options?: { quiet?: boolean }) => Promise<void>
} {
  const serverCurrent = task.progress_current ?? 0
  const [inFlight, setInFlight] = useState(0)
  const [local, setLocal] = useState(serverCurrent)
  const [pinned, setPinned] = useState<{ base: number; value: number } | null>(null)

  const displayed =
    inFlight > 0 ? local : pinned && pinned.base === serverCurrent ? pinned.value : serverCurrent
  const state = trackState(task, displayed)
  const period = periodLabel(task.rrule)
  // The toast's Undo runs from an older render's `log`; through the ref it
  // still sees the count as it is now, not as it was when the toast was made.
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed

  const log = async (delta: 1 | -1, options?: { quiet?: boolean }) => {
    const shown = displayedRef.current
    const next = Math.max(0, shown + delta)
    if (next === shown) return
    setLocal(next)
    setInFlight((n) => n + 1)
    if (!options?.quiet) {
      const target = Math.max(1, task.progress_target ?? 1)
      showToast({
        id: `track-${task.id}`,
        type: 'success',
        message: `${delta > 0 ? 'Logged one for' : 'Removed one from'} \u201c${task.title}\u201d \u00b7 ${next}/${target}`,
        action: { label: 'Undo', onClick: () => void log(delta > 0 ? -1 : 1, { quiet: true }) },
      })
    }
    try {
      const res = await fetch(`/api/tasks/${task.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta }),
      })
      if (!res.ok) throw new Error('Failed to log progress')
      const json = await res.json()
      const settled = Number(json?.data?.progress_current)
      if (Number.isFinite(settled)) setPinned({ base: serverCurrent, value: settled })
    } catch {
      setLocal((v) => Math.max(0, v - delta))
      showToast({ message: `Could not log progress on "${task.title}"`, type: 'error' })
    } finally {
      setInFlight((n) => n - 1)
    }
  }

  return { state, period, log }
}
