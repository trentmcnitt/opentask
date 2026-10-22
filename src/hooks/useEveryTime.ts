'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  createModeTask,
  draftFromTask,
  draftReducer,
  draftToBulkChanges,
  draftToPatch,
  draftsEqual,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeDraft,
  type EveryTimePatch,
  type EveryTimeTask,
} from '@/lib/every-time'
import type { EveryTimeVariant } from '@/components/quick-panel/EveryTimePanel'
import type { Task } from '@/types'

/** An open every-time session: the draft, what it opened with, and what it is checked against. */
interface Session {
  initial: EveryTimeDraft
  draft: EveryTimeDraft
  /** The task the checks read (create: the staged one-off; bulk: a stand-in). */
  task: EveryTimeTask
  /** Pinned when the mode opens, so the planner's memo holds across keystrokes (RT-9). */
  ctx: EveryTimeContext
  focusDeadline: boolean
}

/** A create-mode schedule staged by Done (A7), sent with Create Task. */
export interface StagedSchedule {
  draft: EveryTimeDraft
  ctx: EveryTimeContext
}

/**
 * THE QUICK PANEL'S MODE STATE (2026-10-22, editor plan §2.3; PR 4c): which
 * mode the panel shows — THIS ONE (default) or EVERY TIME — and the every-
 * time draft, kept apart from this-one's staged fields so a Save carries one
 * mode's changes only (RT-4: a deck plus a schedule change is a 400).
 *
 *  - `enter` opens every-time with a FRESH draft of the task as it is now
 *    (`draftFromTask`), the clock pinned for the session;
 *  - `back` returns to this one; with unsaved every-time edits it asks first
 *    (A6, `confirmBack`);
 *  - `dirty` = the draft differs from what it opened with (the unsaved-
 *    changes guards); `patch` is what a single Save would send — a one-off's
 *    "Make it repeat" can be saved untouched (it sends the rule), so Save
 *    reads `saveable`, not `dirty`;
 *  - create mode: Done stages the draft (`staged`), sent with Create Task.
 *  - bulk (A11): the draft opens on the selection's shared rule (all
 *    target-anchored, no deadlines — the gate), or a fresh weekly one.
 */
export function useEveryTime({
  variant,
  task,
  selectedTasks,
  createStaged,
  timezone,
  morningTime,
}: {
  variant: EveryTimeVariant
  task: Task | null
  selectedTasks: Task[]
  createStaged: { dueAt: string | null; deadlineAt: string | null }
  timezone: string
  morningTime: string
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [confirmBack, setConfirmBack] = useState(false)
  const [staged, setStaged] = useState<StagedSchedule | null>(null)

  const enter = useCallback(
    (opts?: { focusDeadline?: boolean }) => {
      const ctx: EveryTimeContext = { timezone, morningTime, now: new Date() }
      let checkTask: EveryTimeTask
      let initial: EveryTimeDraft
      if (variant === 'create') {
        checkTask = createModeTask(createStaged)
        initial = staged?.draft ?? draftFromTask(checkTask, ctx)
      } else if (variant === 'bulk') {
        const first = selectedTasks[0]
        const shared =
          !!first?.rrule &&
          selectedTasks.every(
            (t) => t.rrule === first.rrule && t.recurrence_mode === first.recurrence_mode,
          )
        checkTask = shared ? first : createModeTask({})
        initial = draftFromTask(checkTask, ctx)
      } else {
        checkTask = task!
        initial = draftFromTask(checkTask, ctx)
      }
      setSession({
        initial,
        draft: initial,
        task: checkTask,
        ctx,
        focusDeadline: !!opts?.focusDeadline,
      })
    },
    [variant, task, selectedTasks, createStaged, timezone, morningTime, staged],
  )

  const dispatch = useCallback((action: DraftAction) => {
    setSession((s) => (s ? { ...s, draft: draftReducer(s.draft, action) } : s))
  }, [])

  const dirty = !!session && !draftsEqual(session.initial, session.draft)

  const leave = useCallback(() => {
    setConfirmBack(false)
    setSession(null)
  }, [])
  const back = useCallback(() => {
    if (dirty) setConfirmBack(true)
    else leave()
  }, [dirty, leave])
  const reset = useCallback(() => {
    setSession((s) => (s ? { ...s, draft: s.initial } : s))
  }, [])

  /** A single task's Save: one PATCH (`draftToPatch`). */
  const patch: EveryTimePatch | null = useMemo(
    () =>
      session && variant === 'single'
        ? draftToPatch(session.task, session.draft, session.ctx)
        : null,
    [session, variant],
  )

  /** Whether Save would send anything. */
  const saveable =
    !!session &&
    (variant === 'create' ||
      (variant === 'single' && !!patch && Object.keys(patch).length > 0) ||
      (variant === 'bulk' && (dirty || session.task.rrule === null || session.draft.stop)))

  /** The bulk Save's `changes` for bulk/edit. */
  const bulkChanges = session && variant === 'bulk' ? draftToBulkChanges(session.draft) : null

  /** Create mode's Done: stage the draft (or, with Stop repeating, unstage it) and go back. */
  const stage = useCallback(() => {
    if (!session) return
    setStaged(session.draft.stop ? null : { draft: session.draft, ctx: session.ctx })
    leave()
  }, [session, leave])

  return {
    mode: session ? ('everyTime' as const) : ('thisOne' as const),
    session,
    enter,
    back,
    leave,
    reset,
    dispatch,
    dirty,
    patch,
    saveable,
    bulkChanges,
    confirmBack,
    setConfirmBack,
    staged,
    setStaged,
    stage,
  }
}
