'use client'

import { useCallback, type ReactNode } from 'react'
import { useSession } from 'next-auth/react'
import { useAnchorTimes } from '@/components/PreferencesProvider'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { BeforeDeadlineBlock } from '@/components/quick-panel/BeforeDeadlineBlock'
import { formatQuickSelectHeader, formatRelativeTime } from '@/lib/quick-select-dates'
import {
  defaultPick,
  pickOf,
  pickSlot,
  pickWords,
  relativePreview,
  type RelativePick,
  type SlotChoice,
} from '@/lib/relative-target-ui'
import { isRelativeOneOff } from '@/lib/task-segments'
import type { Task } from '@/types'

/**
 * THE PERIODS THE EDITOR MAY LINK A TARGET TO (relative targets, 2026-10-24):
 * the user's own reminder periods — on a task they own (and in create mode).
 * A link names the OWNER's period, and a collaborator can't read the owner's
 * (`/api/time-slots` is the caller's), so on someone else's task: none — the
 * controls offer custom times only, and a stored link reads as its time.
 *
 * `morning` is "Default task time" as a default pick copies it (ruling 10):
 * linked while the setting follows one of these periods, else its time.
 */
export function useLinkableSlots(task: Task | null, isCreateMode: boolean) {
  // The page's shared list (`useTimeSlots`): read, never re-fetched per open —
  // the editor opens often, and a surface's sync handler keeps it current.
  const { timeSlots, loaded } = useTimeSlots(undefined, { revalidate: false })
  const { data: session } = useSession()
  const anchors = useAnchorTimes()
  const owns = isCreateMode || (!!task && String(task.user_id) === session?.user?.id)
  const slots: SlotChoice[] = owns && loaded ? timeSlots : []
  const morningSlotId =
    anchors.morning.slot_id !== null && slots.some((s) => s.id === anchors.morning.slot_id)
      ? anchors.morning.slot_id
      : null
  return { slots, morning: { time: anchors.morning.time, slot_id: morningSlotId }, morningSlotId }
}

/**
 * A ONE-OFF'S RELATIVE TARGET IN THE EDITOR (2026-10-24, plan §9; the pure
 * rules are src/lib/relative-target-ui.ts): what the Target row shows, and
 * the picker's "Before the deadline" block.
 *
 * STAGING: a pick (a chip, or the control's Set) is `pending` — saved in the
 * same PATCH as a staged deadline (`pickFields`, never with a `target_at`).
 * Staging one drops a staged date and deck (`onStage`); every pad tap, Set
 * Date, Now, Next Hour and Remove target drop it in turn (ruling 1 — the
 * panel's handlers). With nothing picked the control opens on the day before
 * at Default task time (ruling 10).
 *
 * OFFERED on a single one-off (or create mode) with a deadline still ahead —
 * not a reminder, a quota, a repeat, bulk, a done task or read-only. The row
 * shows a stored relative target wherever it is (a past deadline too).
 */
export function useRelativeTarget(s: {
  task: Task | null
  pending: RelativePick | null
  setPending: (pick: RelativePick | null) => void
  /** Drop a staged date and deck (a relative pick replaces them). */
  onStage: () => void
  offered: boolean
  /** The single one-off the row is about (not bulk, a reminder, a quota or a repeat). */
  oneOff: boolean
  deadline: string | null
  deadlineStaged: boolean
  /** A fixed date, a removed target or a deck is staged. */
  fixedStaged: boolean
  slots: readonly SlotChoice[]
  morning: { time: string; slot_id: number | null }
  timezone: string
  dayStart: string
}) {
  const { task, pending, setPending, onStage, slots, timezone } = s
  const stored = task && s.oneOff && isRelativeOneOff(task) ? pickOf(task) : null
  const preview = s.oneOff
    ? relativePreview({
        stored,
        staged: pending,
        deadline: s.deadline,
        fixedStaged: s.fixedStaged,
        deadlineStaged: s.deadlineStaged,
        storedTarget: task?.due_at ?? null,
        timezone,
      })
    : null
  const now = new Date()
  const targetValue = preview
    ? {
        header: formatQuickSelectHeader(preview.at, timezone, s.dayStart, now),
        relative: formatRelativeTime(preview.at, timezone, s.dayStart, now),
        words: pickWords(preview.pick, slots),
        dirty: preview.dirty,
        past: Date.parse(preview.at) < now.getTime(),
      }
    : null

  const stage = useCallback(
    (pick: RelativePick) => {
      onStage()
      setPending(pick)
    },
    [onStage, setPending],
  )

  const deadline = s.deadline
  const offered = s.offered && !!deadline && Date.parse(deadline) > now.getTime()
  // The control opens on the pick the row shows (a link the viewer can't
  // see reads as its time), else the default.
  const shown = preview?.pick ?? null
  const current: RelativePick = shown
    ? { ...shown, slot_id: pickSlot(shown, slots)?.id ?? null }
    : defaultPick(s.morning, true)
  const beforeCalendar = offered
    ? (close: () => void): ReactNode => (
        <BeforeDeadlineBlock
          deadlineAt={deadline!}
          timezone={timezone}
          slots={slots}
          current={current}
          currentIsSet={!!shown}
          onPick={(pick) => {
            stage(pick)
            close()
          }}
        />
      )
    : null

  return { preview, targetValue, beforeCalendar }
}
