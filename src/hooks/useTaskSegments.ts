'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { showToast } from '@/lib/toast'
import {
  effectiveHorizon,
  type HorizonValue,
  type SegmentKind,
  type SegmentState,
} from '@/lib/task-segments'
import { HORIZON_LABELS, SEGMENT_TITLES } from '@/lib/task-model-words'
import type { TaskSegmentPayload } from '@/hooks/useReminders'
import type { Task } from '@/types'

/**
 * The task segments' actions (2026-10-10, docs/TASK-MODEL.md § Task segments).
 *
 * OPTIMISTIC: a tap changes the row at once (perf is Trent's top irritation),
 * then the request goes out and the surface refreshes. The overlay is a map of
 * task id → what the tap made of it; a failure takes the entry back out and
 * says so. Every write has an Undo on its toast — a misfire is undone with the
 * standard Undo (spec §3), never a confirm.
 *
 * - circle → consider: "I saw it", never a completion
 * - checkbox → done (`POST /api/tasks/{id}/done`, the same as a dashboard tick)
 * - Target today → a deliberate target today; the row leaves the segment
 * - Target at… (hold or right-click on Today, 2026-10-12) → the same request
 *   with the picked moment (`at`). The row leaves, whatever the day: today it
 *   is over target, a later day makes it quiet until then (spec §1 — a
 *   targeted one-off is in no horizon segment, and set today it has no
 *   heads-up today)
 * - Remove target (Upcoming's one-off rows with no deadline, 2026-10-12) →
 *   `PATCH { target_at: null }`; the task goes back to its horizon segment.
 *   "Back to auto" (a one-off with a deadline, §8.3) is the same PATCH: the
 *   server puts the deadline's automatic target back, and the row leaves
 *   Upcoming (an automatic target has no heads-ups)
 * - Repeating Upcoming rows have Today and its picker too (§6: moving the
 *   target leaves the occurrence where it was), but no target reset
 * - Defer All → everything still waiting in that segment, back tomorrow
 * - Considered all (task queue PR 3, spec rule 9) → every row still waiting
 *   in that segment considered in ONE call to /api/task-segments/consider —
 *   one undo entry, Undo on the toast. A queued one-off leaves the queue for
 *   its horizon segment (ticked there today); a waiting repeating task stays
 * - the details icon (resolution 10) → `openDetails`: the Quick panel for
 *   that task (`SegmentDetailsModal`, which each surface renders)
 * - horizon chip → a new horizon (the row may change segment on refresh; the
 *   toast then says "Moved to <panel title>", e.g. "Moved to Monthly")
 */

type Overlay = SegmentState | 'gone'

export interface SegmentRow {
  task: Task
  state: SegmentState
  /** A repeating task's occurrence (Upcoming): circle and done only. */
  recurring: boolean
}

export interface SegmentView {
  horizon: SegmentKind
  rows: SegmentRow[]
  waiting: number
  considered: number
  deferred: number
  nudge: boolean
}

interface UseTaskSegmentsOptions {
  segments: TaskSegmentPayload[]
  /** The user's timezone, for the Today menu's toast. */
  timezone: string
  refresh: () => Promise<void>
  onUndo: () => void
  onCompleted?: () => void
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string; data?: unknown } | null
  if (!res.ok) throw new Error(json?.error || 'Request failed')
  return json?.data
}

export function useTaskSegments({
  segments,
  timezone,
  refresh,
  onUndo,
  onCompleted,
}: UseTaskSegmentsOptions) {
  const [overlay, setOverlay] = useState<Map<number, Overlay>>(new Map())
  // The payload the overlay was made against. A fresh payload is the truth, so
  // it replaces the overlay — but only once every request out has answered,
  // or a refresh landing mid-request would flash the old state back.
  const inFlight = useRef(0)
  const seenSegments = useRef(segments)
  if (seenSegments.current !== segments && inFlight.current === 0) {
    seenSegments.current = segments
    if (overlay.size > 0) setOverlay(new Map())
  }

  const view: SegmentView[] = useMemo(
    () =>
      segments
        .map((seg) => {
          const rows = seg.tasks
            .map((t) => ({
              task: t as Task,
              state: overlay.get(t.id) ?? t.segment_state,
              recurring: t.recurring ?? t.rrule !== null,
            }))
            .filter((r): r is SegmentRow => r.state !== 'gone')
          const count = (s: SegmentState) => rows.filter((r) => r.state === s).length
          return {
            horizon: seg.horizon,
            rows,
            waiting: count('waiting'),
            considered: count('considered'),
            deferred: count('deferred'),
            nudge: seg.nudge,
          }
        })
        .filter((seg) => seg.rows.length > 0),
    [segments, overlay],
  )

  const run = useCallback(
    async (ids: number[], to: Overlay, send: () => Promise<unknown>, message: string) => {
      setOverlay((prev) => {
        const next = new Map(prev)
        for (const id of ids) next.set(id, to)
        return next
      })
      inFlight.current++
      try {
        await send()
        toastResult(message, onUndo)
        onCompleted?.()
      } catch (err) {
        setOverlay((prev) => {
          const next = new Map(prev)
          for (const id of ids) next.delete(id)
          return next
        })
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Something went wrong',
          type: 'error',
        })
      } finally {
        inFlight.current--
        void refresh()
      }
    },
    [onUndo, onCompleted, refresh],
  )

  const consider = useCallback(
    (task: Task) =>
      run(
        [task.id],
        'considered',
        () => post('/api/task-segments/consider', { ids: [task.id] }),
        'Considered',
      ),
    [run],
  )
  const done = useCallback(
    (task: Task) =>
      run([task.id], 'gone', () => post(`/api/tasks/${task.id}/done`, {}), `Done: “${task.title}”`),
    [run],
  )
  const targetToday = useCallback(
    (task: Task) =>
      run(
        [task.id],
        'gone',
        () => post('/api/task-segments/target-today', { ids: [task.id] }),
        // Says what did NOT happen: Today sits beside Done, and a mis-tap
        // read as a check-off until the toast (2026-10-12).
        `Targeted for today, not done: “${task.title}”`,
      ),
    [run],
  )
  const picker = useTargetPicker(run, timezone)
  const deferAll = useCallback(
    (segment: SegmentView) => {
      const ids = segment.rows.filter((r) => r.state === 'waiting').map((r) => r.task.id)
      if (ids.length === 0) return
      return run(
        ids,
        'deferred',
        () => post('/api/task-segments/defer', { ids }),
        ids.length === 1
          ? 'Deferred 1 task to tomorrow'
          : `Deferred ${ids.length} tasks to tomorrow`,
      )
    },
    [run],
  )
  const setHorizon = useSetHorizon(inFlight, onUndo, refresh, onCompleted)

  // Put back (2026-10-11): a considered or deferred row from "Show N
  // considered" waits again — the slots' put-back.
  const restore = useCallback(
    (task: Task) =>
      run(
        [task.id],
        'waiting',
        () => post('/api/task-segments/restore', { ids: [task.id] }),
        `Put back: “${task.title}”`,
      ),
    [run],
  )

  const considerAll = useConsiderAll(run)
  // The details icon's Quick panel: which task is open (`SegmentDetailsModal`).
  const [detailsTask, setDetailsTask] = useState<Task | null>(null)

  const removeTarget = useRemoveTarget(run)
  const actions = {
    consider,
    considerAll,
    done,
    targetToday,
    deferAll,
    setHorizon,
    restore,
    removeTarget,
  }
  return {
    segments: view,
    ...actions,
    ...picker,
    detailsTask,
    openDetails: setDetailsTask as (task: Task) => void,
    closeDetails: () => setDetailsTask(null),
    refresh,
  }
}

/**
 * The horizon dot's menu (switch off) — a PATCH of `horizon`, with Undo. Not
 * through `run`: the row stays where it is until the refresh says otherwise.
 */
function useSetHorizon(
  inFlight: { current: number },
  onUndo: () => void,
  refresh: () => Promise<void>,
  onCompleted?: () => void,
) {
  return useCallback(
    async (task: Task, horizon: HorizonValue | null, segment?: SegmentKind) => {
      inFlight.current++
      try {
        const res = await fetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ horizon }),
        })
        if (!res.ok) throw new Error('Could not change the horizon')
        showToast({
          message: horizonToast(task, horizon, segment),
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted?.()
      } catch (err) {
        showToast({ message: err instanceof Error ? err.message : 'Failed', type: 'error' })
      } finally {
        inFlight.current--
        void refresh()
      }
    },
    [inFlight, onUndo, onCompleted, refresh],
  )
}

/**
 * Considered all (task queue PR 3, spec rule 9): every row still waiting in
 * the segment, in one consider call — one undo entry, Undo on the toast.
 */
function useConsiderAll(run: RunSegmentAction) {
  return useCallback(
    (segment: SegmentView) => {
      const ids = segment.rows.filter((r) => r.state === 'waiting').map((r) => r.task.id)
      if (ids.length === 0) return
      return run(
        ids,
        'considered',
        () => post('/api/task-segments/consider', { ids }),
        ids.length === 1 ? 'Considered 1 task' : `Considered ${ids.length} tasks`,
      )
    },
    [run],
  )
}

type RunSegmentAction = (
  ids: number[],
  to: Overlay,
  send: () => Promise<unknown>,
  message: string,
) => Promise<void>

/**
 * Remove target / Back to auto (2026-10-12, `targetReset`): the same PATCH
 * the dashboard's row menu sends. With no deadline the task goes back to its
 * horizon segment; with one, the server puts the deadline's automatic target
 * back (§8.3). Either way the row leaves Upcoming; Undo restores the target
 * and `target_set_at`.
 */
function useRemoveTarget(run: RunSegmentAction) {
  return useCallback(
    (task: Task) =>
      run(
        [task.id],
        'gone',
        () => patchTask(task.id, { target_at: null }),
        task.deadline_at
          ? `Back to the automatic target: “${task.title}”`
          : `Target removed: “${task.title}”`,
      ),
    [run],
  )
}

/**
 * A write's toast, with Undo. (Target-today no longer skips repeating tasks —
 * §6 keeps the occurrence apart from the target, 2026-10-12 — so its
 * `skipped_recurring` is always empty and needs no wording.)
 */
function toastResult(message: string, onUndo: () => void): void {
  showToast({ message, type: 'success', action: { label: 'Undo', onClick: onUndo } })
}

async function patchTask(id: number, body: unknown): Promise<unknown> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string; data?: unknown } | null
  if (!res.ok) throw new Error(json?.error || 'Request failed')
  return json?.data
}

/**
 * The Today button's menu and picker (2026-10-12, a menu since 10-14): the
 * targeting each choice sends (`at`), through the same optimistic `run`.
 */
function useTargetPicker(run: RunSegmentAction, timezone: string) {
  const targetAt = useCallback(
    (task: Task, at: string) => {
      const when = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone)
      const today = DateTime.now().setZone(timezone)
      return run(
        [task.id],
        // Any day: the row leaves. A targeted one-off is in no horizon
        // segment (spec §1, 2026-10-12), and one targeted today has no
        // heads-up today — the refresh shows the same.
        'gone',
        () => post('/api/task-segments/target-today', { ids: [task.id], at }),
        `Targeted ${targetWhen(when, today)}: “${task.title}”`,
      )
    },
    [run, timezone],
  )
  return { targetAt }
}

/**
 * "today 3:00 PM", "tomorrow 9:00 AM", "Tue, Oct 13 3:00 PM" — the picker's
 * toast. Also the dashboard rows' Today toast (`useTaskActions.handleTargetAt`).
 */
export function targetWhen(when: DateTime, today: DateTime): string {
  const time = when.toFormat('h:mm a')
  if (when.hasSame(today, 'day')) return `today ${time}`
  if (when.hasSame(today.plus({ days: 1 }), 'day')) return `tomorrow ${time}`
  return `${when.toFormat('ccc, LLL d')} ${time}`
}

/**
 * The horizon chip's toast. When the change moves the row to another segment,
 * it says where it went, by the panel's title ("Moved to Monthly", 2026-10-11;
 * the title since 2026-10-20) — the row is about to leave the list, and
 * "Horizon: Months" didn't say that. Compared on the EFFECTIVE horizon (a
 * deadline can pull a task in, so a new set horizon may leave it where it
 * is); unchanged, it keeps the plain "Horizon: X".
 */
function horizonToast(task: Task, horizon: HorizonValue | null, segment?: SegmentKind): string {
  if (segment) {
    const next = effectiveHorizon({ horizon, deadline_at: task.deadline_at }, new Date())
    if (next !== segment) return `Moved to ${SEGMENT_TITLES[next]}`
  }
  return horizon ? `Horizon: ${HORIZON_LABELS[horizon]}` : 'Horizon cleared'
}

export type TaskSegmentActions = ReturnType<typeof useTaskSegments>
