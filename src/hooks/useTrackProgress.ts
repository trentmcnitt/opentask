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
 * count: each tap adjusts it at once, and the requests go out ONE AT A TIME so
 * the server applies them in the order they were tapped. They used to fire
 * concurrently, which was wrong in a way nothing noticed for months: the server
 * clamps at zero (a correction may undo a mis-log, not manufacture history), so
 * a +1 and the −1 that takes it back, in flight together and applied in the
 * wrong order, clamp the −1 away and leave the count one too high — a state the
 * optimistic display hides until the next reload. Tap then Undo is the toast's
 * own advertised gesture, so that is the main path, not an edge case. Queuing
 * costs nothing visible: the count still moves on the tap. When the last
 * request settles, the server's answer is pinned until the task prop catches up — keyed to the prop value
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
  // The pin must be keyed to the server value AS OF SETTLING, not as of the
  // tap. Tap then hold quickly: the +1 settles, the sync refresh brings 1,
  // then the −1 settles — keyed to the 0 it was tapped against it would not
  // match the prop (1), the server value would show, and the count would
  // bounce 0 → 1 → 0 until the next refresh (Trent, 2026-09-05).
  const serverRef = useRef(serverCurrent)
  serverRef.current = serverCurrent
  // The tail of this task's request queue. Assigned synchronously inside `log`,
  // before any await, so two taps in the same tick still queue in order.
  const queue = useRef<Promise<void>>(Promise.resolve())

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
    // Never rejects, so one failed request cannot break the queue for the taps
    // behind it.
    const sent = queue.current.then(async () => {
      try {
        const res = await fetch(`/api/tasks/${task.id}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delta }),
        })
        if (!res.ok) throw new Error('Failed to log progress')
        const json = await res.json()
        const settled = Number(json?.data?.progress_current)
        if (Number.isFinite(settled)) setPinned({ base: serverRef.current, value: settled })
      } catch {
        setLocal((v) => Math.max(0, v - delta))
        showToast({ message: `Could not log progress on "${task.title}"`, type: 'error' })
      } finally {
        setInFlight((n) => n - 1)
      }
    })
    queue.current = sent
    await sent
  }

  return { state, period, log }
}
