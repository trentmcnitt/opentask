'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { showToast } from '@/lib/toast'
import type { HorizonValue, SegmentState } from '@/lib/task-segments'
import { HORIZON_LABELS } from '@/lib/task-model-words'
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
 * - Defer All → everything still waiting in that segment, back tomorrow
 * - horizon chip → a new horizon (the row may change segment on refresh)
 */

type Overlay = SegmentState | 'gone'

export interface SegmentRow {
  task: Task
  state: SegmentState
}

export interface SegmentView {
  horizon: HorizonValue
  rows: SegmentRow[]
  waiting: number
  considered: number
  deferred: number
  nudge: boolean
}

interface UseTaskSegmentsOptions {
  segments: TaskSegmentPayload[]
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
            .map((t) => ({ task: t as Task, state: overlay.get(t.id) ?? t.segment_state }))
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
        showToast({ message, type: 'success', action: { label: 'Undo', onClick: onUndo } })
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
        `Targeted today: “${task.title}”`,
      ),
    [run],
  )
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
  const setHorizon = useCallback(
    async (task: Task, horizon: HorizonValue | null) => {
      inFlight.current++
      try {
        const res = await fetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ horizon }),
        })
        if (!res.ok) throw new Error('Could not change the horizon')
        showToast({
          message: horizon ? `Horizon: ${HORIZON_LABELS[horizon]}` : 'Horizon cleared',
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
    [onUndo, onCompleted, refresh],
  )

  return { segments: view, consider, done, targetToday, deferAll, setHorizon }
}

export type TaskSegmentActions = ReturnType<typeof useTaskSegments>
