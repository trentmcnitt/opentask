'use client'

import { useState } from 'react'
import { Check, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { periodLabel, trackState } from '@/lib/track'
import { showToast } from '@/lib/toast'
import type { Task } from '@/types'

/**
 * The progress row for a tracked task (REDESIGN-V03 §5), rendered inside
 * TaskRow in place of the usual due-date line.
 *
 *   [−]  ▮▮▮▯▯  2 / 3 this week  [+1]
 *
 * What the design fixes, and why this component looks the way it does:
 *
 * - **A quota is aims the user owns, not a contract the app polices.** No red
 *   state, no "behind" alarm, no streak. The bar fills; that is all it says.
 * - **Met is a state, not an exit.** Reaching the target shows a check and the
 *   count keeps going (3/2) until the period rolls over — the user chose this
 *   on Jul 26 so overflow stays observable. The row's own circle still
 *   completes early if he wants it closed.
 * - **Unlogged is not missed.** The minus exists because logging is loose and
 *   mis-taps happen; it is a correction, so it never goes below zero and is
 *   disabled there.
 *
 * OPTIMISTIC, and safe under rapid taps: while any request is in flight the
 * row shows its own running count (each tap adjusts it at once, requests fire
 * independently and the server applies them in order). When the last request
 * settles, the row pins the server's answer until the task prop catches up —
 * keyed to the prop value it was pinned against, so a refetch (sync stream,
 * undo) that brings a *new* value replaces it and a stale one is ignored. This
 * is what stops the count dipping to an older value for a beat between a
 * response and the refetch it triggered. A failed request reverts its own
 * delta and says so.
 */
export function TrackProgress({ task }: { task: Task }) {
  const serverCurrent = task.progress_current ?? 0
  const [inFlight, setInFlight] = useState(0)
  const [local, setLocal] = useState(serverCurrent)
  const [pinned, setPinned] = useState<{ base: number; value: number } | null>(null)

  const displayed =
    inFlight > 0 ? local : pinned && pinned.base === serverCurrent ? pinned.value : serverCurrent
  const state = trackState(task, displayed)
  const period = periodLabel(task.rrule)

  const log = async (delta: 1 | -1) => {
    const next = Math.max(0, displayed + delta)
    if (next === displayed) return
    setLocal(next)
    setInFlight((n) => n + 1)
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

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div
      className="mt-1.5 flex items-center gap-2"
      data-track-progress
      // The row itself selects / opens on click; taps here are logging, not
      // navigation. Only the click is stopped — the row's pointer tracking
      // (long-press, double-click) must still see down/up pairs, exactly as it
      // does for the Done circle; swallowing pointerdown here left it with an
      // orphan pointerup that suppressed the button's click entirely.
      onClick={stop}
    >
      <button
        type="button"
        onClick={() => void log(-1)}
        disabled={state.current === 0}
        aria-label={`Remove one from "${task.title}"`}
        title="Remove one"
        className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Minus className="size-3.5" strokeWidth={2.5} />
      </button>

      {/* The bar flexes so the control fits a 375px row beside the score badge;
          the period label folds away there and the count never wraps. */}
      <div
        className="bg-muted relative h-1.5 min-w-10 flex-1 overflow-hidden rounded-full sm:max-w-32"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={state.target}
        aria-valuenow={state.current}
        aria-label={`${state.current} of ${state.target}${period ? ` ${period}` : ''}`}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 ease-out',
            state.met ? 'bg-green-600' : 'bg-foreground/60',
          )}
          style={{ width: `${state.fraction * 100}%` }}
        />
      </div>

      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-sm whitespace-nowrap tabular-nums',
          state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
        )}
        data-track-count
      >
        {state.met && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
        <span>
          <span className="text-foreground font-medium">{state.current}</span> / {state.target}
        </span>
        {period && <span className="text-muted-foreground/70 hidden sm:inline">{period}</span>}
        {state.met && <span className="text-muted-foreground/70">· met</span>}
      </span>

      <button
        type="button"
        onClick={() => void log(1)}
        aria-label={`Log one more for "${task.title}"`}
        title="Log one more"
        className="text-foreground hover:bg-foreground/5 ml-auto flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors"
      >
        <Plus className="size-3.5" strokeWidth={2.5} />1
      </button>
    </div>
  )
}
