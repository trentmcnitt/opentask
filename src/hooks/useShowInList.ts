'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { resolveTaskLink } from '@/lib/task-link'
import { SHOW_IN_LIST_EVENT, hiddenByNarrowingMessage } from '@/lib/show-in-list'
import { showToast } from '@/lib/toast'
import type { ModeId } from '@/lib/modes/types'
import type { Task } from '@/types'

/**
 * The dashboard's side of SHOW IN LIST (`src/lib/show-in-list.ts`): a request
 * — the bubble's event, or `?task=<id>&show=1` through `request` — is held
 * until the list can answer it, then resolved once with the deep link's own
 * rule (`resolveTaskLink`):
 *
 * - the modes on and not on All → switch to All first (a render later the
 *   list holds every open task);
 * - the row is in a group → `reveal` (unfold, scroll, flash);
 * - a filter or search hides it → a toast that says so, with "Clear" (which
 *   clears the narrowing and asks again); never cleared silently;
 * - anything else → a toast, never a silent landing elsewhere.
 *
 * The pending id lives in a ref (no state set in the effect); a request bumps
 * a counter so the effect runs.
 */
export function useShowInList({
  loading,
  viewKnown,
  tasks,
  listed,
  groups,
  modesOn,
  mode,
  setMode,
  searching,
  reveal,
  clearNarrowing,
  onMissing,
}: {
  /** The list isn't loaded yet. */
  loading: boolean
  /** The list's view is known (`groupingLoaded`): its groups are the real ones. */
  viewKnown: boolean
  /** Every open task the page loaded. */
  tasks: Task[]
  /** The list after search, filter chips and AI chips. */
  listed: Task[]
  /** The list's groups as drawn. */
  groups: { label: string; tasks: Task[] }[]
  modesOn: boolean
  mode: ModeId | null
  setMode: (mode: ModeId) => void
  /** A search narrows the list (the toast says "search", else "filters"). */
  searching: boolean
  reveal: (taskId: number, groupLabel: string) => void
  clearNarrowing: () => void
  /** A task that isn't open (done, trashed, gone): the deep link's toast. */
  onMissing: (taskId: number) => void
}) {
  const pending = useRef<number | null>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const request = useCallback((taskId: number) => {
    pending.current = taskId
    bump()
  }, [])

  useEffect(() => {
    const onEvent = (e: Event) => request((e as CustomEvent<number>).detail)
    window.addEventListener(SHOW_IN_LIST_EVENT, onEvent)
    return () => window.removeEventListener(SHOW_IN_LIST_EVENT, onEvent)
  }, [request])

  useEffect(() => {
    const taskId = pending.current
    if (taskId === null) return
    if (modesOn && mode !== 'all') {
      setMode('all')
      return
    }
    // Wait for the list: loaded, its view known, and its tasks in.
    if (loading || !viewKnown || tasks.length === 0) return
    pending.current = null
    const step = resolveTaskLink({ taskId, tasks, listed, groups, tried: { narrowing: false } })
    if (step.kind === 'show') {
      reveal(step.task.id, step.groupLabel)
    } else if (step.kind === 'clear-narrowing') {
      const task = tasks.find((t) => t.id === taskId)
      showToast({
        message: hiddenByNarrowingMessage(task?.title ?? 'That task', searching),
        action: {
          label: 'Clear',
          onClick: () => {
            clearNarrowing()
            request(taskId)
          },
        },
      })
    } else if (step.kind === 'missing') {
      onMissing(taskId)
    } else {
      showToast({ message: `Couldn’t show “${step.task.title}” in the list` })
    }
  })

  return request
}
