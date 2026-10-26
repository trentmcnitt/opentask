'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  createModeTask,
  draftFromTask,
  draftProblem,
  draftReducer,
  draftToBulkChanges,
  draftToPatch,
  draftsEqual,
  scheduleEditable,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeDraft,
  type EveryTimePatch,
  type EveryTimeTask,
} from '@/lib/every-time'
import type { EveryTimeVariant } from '@/components/quick-panel/EveryTimePanel'
import { useDayStart } from '@/components/PreferencesProvider'
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
  /**
   * Bulk: the selected tasks repeat on different rules (or some don't), so
   * the draft is only a placeholder — an untouched one never replaces them.
   */
  mixed: boolean
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
  morningSlotId = null,
  leads = false,
}: {
  variant: EveryTimeVariant
  task: Task | null
  selectedTasks: Task[]
  createStaged: Parameters<typeof createModeTask>[0]
  timezone: string
  morningTime: string
  /**
   * The period "Default task time" follows, when the user may link this
   * task's target to it (they own it) — a default relative target copies it
   * (ruling 10, `EveryTimeContext.morningSlotId`).
   */
  morningSlotId?: number | null
  /**
   * The deadlines page is on (the task-queue switch, 2026-10-22, L1): a
   * deadline-anchored repeat made from a one-off with no target gets no
   * default relative target (`EveryTimeContext.leads`).
   */
  leads?: boolean
}) {
  const [session, setSession] = useState<Session | null>(null)
  // The discard question (A6), and what a yes leads to: back to this one,
  // or Cancel (which closes the host).
  const [confirm, setConfirm] = useState<'back' | 'cancel' | null>(null)
  const [staged, setStaged] = useState<StagedSchedule | null>(null)
  // "Back to this one" for the live region once the mode has been left.
  const [left, setLeft] = useState(false)
  // The user's day ("OpenTask day everywhere" part 2): a new rule's default
  // weekday and its first occurrence count from the OpenTask day.
  const dayStart = useDayStart()

  const enter = useCallback(
    (opts?: { focusDeadline?: boolean }) => {
      const ctx: EveryTimeContext = {
        timezone,
        morningTime,
        morningSlotId,
        now: new Date(),
        dayStart,
        leads,
      }
      let checkTask: EveryTimeTask
      let initial: EveryTimeDraft
      let mixed = false
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
        mixed = !shared && selectedTasks.some((t) => !!t.rrule)
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
        mixed,
      })
      setLeft(false)
    },
    [
      variant,
      task,
      selectedTasks,
      createStaged,
      timezone,
      morningTime,
      morningSlotId,
      dayStart,
      leads,
      staged,
    ],
  )

  const dispatch = useCallback((action: DraftAction) => {
    setSession((s) => (s ? { ...s, draft: draftReducer(s.draft, action) } : s))
  }, [])

  const dirty = !!session && !draftsEqual(session.initial, session.draft)

  const leave = useCallback(() => {
    setConfirm(null)
    setSession(null)
    setLeft(true)
  }, [])
  /** Back to this one; with unsaved changes, ask first (A6). */
  const back = useCallback(() => {
    if (dirty) setConfirm('back')
    else leave()
  }, [dirty, leave])
  /**
   * Cancel: with unsaved changes, the same question first; the caller's
   * `close` runs on a yes (or at once when clean).
   */
  const cancel = useCallback(
    (close: () => void) => {
      if (dirty) setConfirm('cancel')
      else close()
    },
    [dirty],
  )
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

  /**
   * Why the draft can't be saved (the server's own checks, `draftProblem`):
   * Save is disabled, and a host's save-and-leave declines rather than
   * sending a half-picked draft.
   */
  const problem = useMemo(
    () => (session ? draftProblem(session.task, session.draft, session.ctx) : null),
    [session],
  )

  /** Whether Save would send anything (and may). */
  const saveable =
    !!session &&
    !problem &&
    (variant === 'create' ||
      (variant === 'single' && !!patch && Object.keys(patch).length > 0) ||
      (variant === 'bulk' && bulkSaveable(session, dirty)))

  /** The rule is one the draft can't hold: read-only, Stop repeating only. */
  const locked = !!session && !scheduleEditable(session.task)

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
    problem,
    saveable,
    locked,
    bulkChanges,
    confirm,
    setConfirm,
    cancel,
    /** What the live region says: "Editing every time" / "Back to this one" / nothing yet. */
    announce: session ? 'Editing every time' : left ? 'Back to this one' : '',
    staged,
    setStaged,
    stage,
  }
}

/**
 * A bulk Save sends a rule to every selected task: a changed draft, Stop
 * repeating, or — when none of them repeats — the proposed rule as it is.
 * An untouched placeholder never replaces rules the tasks already have.
 */
function bulkSaveable(session: Session, dirty: boolean): boolean {
  if (dirty || session.draft.stop) return true
  return !session.mixed && session.task.rrule === null
}
