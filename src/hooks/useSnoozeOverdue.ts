/**
 * Shared hook for the Defer button ("snooze all overdue", or the selection).
 *
 * Used by the dashboard. Sends overdue task IDs — or, with a selection, the
 * selected ones whose target is before the defer time — to the bulk snooze endpoint and shows a toast with results.
 *
 * Without a selection: P0-P2 are always eligible. P3 (High) joins in once
 * nothing lower is left in the batch, so a list of nothing but overdue High tasks takes two presses
 * rather than refusing to move — with the server's task queue on, one High per
 * press. P4 (Urgent) is never bulk-snoozed. The rule lives in
 * `filterForBulkSnooze`; the server decides, this hook only reports (the
 * server's `summary` line, when it sends one).
 */

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { useCallback } from 'react'
import { isOverdue } from '@/lib/task-counts'
import type { Task } from '@/types'
import { showToast } from '@/lib/toast'
import { bulkSnoozeMessage, computeSnoozeTime, snoozeOptionNeedsDay } from '@/lib/snooze'
import {
  nothingToDeferMessage,
  selectionHeldBackSuffix,
  splitSelectionDefer,
} from '@/lib/defer-selection'
import { nextPeriodStart, type TimeSlot } from '@/lib/time-slot-assign'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'
import { useDayStart, useDayStartKnown } from '@/components/PreferencesProvider'

interface UseSnoozeOverdueOptions {
  displayTasks: Task[]
  /** The selected task rows (reminders and quotas already left out). */
  selectedTasks: Task[]
  /** After a selection's defer succeeds — the dashboard clears the selection. */
  onSelectedDone?: () => void
  fetchTasks: () => void
  handleUndo: () => void
  onUndoCountBump?: () => void
  timezone: string
  defaultSnoozeOption: string
  /** What a plain press does: the next time slot, or `defaultSnoozeOption`. */
  bulkSnoozeDefault: BulkSnoozeDefault
  timeSlots: TimeSlot[]
  morningTime: string
}

/**
 * Returns the two presses of the Defer button (`SnoozeOverdueTrigger`):
 *
 * - `snoozeOverdue(until?)` — no selection: every overdue task in
 *   `displayTasks`. The server handles priority filtering (see the block
 *   comment above).
 * - `snoozeSelected(until?)` — a selection (Trent, 2026-10-26: "the bulk
 *   snooze fab would have just applied to the selected items"). DEFER ONLY
 *   EVER MOVES A TARGET LATER: of the selected tasks, only those whose target
 *   is before the defer time are sent; the ones already later, or with no
 *   target, are left alone and counted in the toast ("Deferred 2 tasks · 1
 *   already later") — `splitSelectionDefer` in `src/lib/defer-selection.ts`.
 *   When none qualifies, no request is sent and the toast says why. A
 *   selection is deliberate, so the ids sent ride in `include_task_ids` too
 *   and High and Urgent move like the rest; the deadline cap still applies.
 *   It is still a DEFER (`source: 'sweep'`): the same button and the same
 *   "not now" gesture, so with the task queue on a selected task lands and
 *   is marked exactly as Defer all would have done — see docs/TASK-MODEL.md
 *   § Picks and defers. `onSelectedDone` (the dashboard clears the
 *   selection) runs only once the defer went through, so a failure — or a
 *   press that had nothing to move — leaves the selection in place.
 *
 * Both resolve the destination the same way (`resolveDeferTime`) — the
 * optional `until` from the long-press menu, else the next period or the
 * default option per the bulk-snooze setting — into ONE absolute time, so a
 * press is one request and one undo entry, and the selection's "later than"
 * test reads the very time the request carries.
 */
export function useSnoozeOverdue(options: UseSnoozeOverdueOptions) {
  const {
    displayTasks,
    selectedTasks,
    onSelectedDone,
    fetchTasks,
    handleUndo,
    onUndoCountBump,
    timezone,
    defaultSnoozeOption,
    bulkSnoozeDefault,
    timeSlots,
    morningTime,
  } = options
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()

  /** The press's one absolute defer time, or null (with a toast) while the day is unknown. */
  const resolveDeferTime = useCallback(
    (until: string | undefined): string | null => {
      // A plain press goes to the NEXT PERIOD by default (Trent, 2026-09-22:
      // "I want the default bulk snooze... to default to next period"), with a
      // setting to flip back to the default snooze option. With no slots there
      // is no next period, so the option is the fallback either way.
      const nextPeriod =
        bulkSnoozeDefault === 'next_period'
          ? nextPeriodStart(timeSlots, timezone, new Date())
          : null
      // The default option can be "next_period" too (2026-10-10), so it gets
      // the slots as well; with none it reads as +1h.
      // "Tomorrow" / "next period" need the user's day: before it is known
      // (the preferences still loading, nothing remembered) the press waits.
      if (
        !dayKnown &&
        until === undefined &&
        !nextPeriod &&
        snoozeOptionNeedsDay(defaultSnoozeOption)
      ) {
        showToast({ message: 'One moment — loading your settings' })
        return null
      }
      return (
        until ??
        nextPeriod ??
        computeSnoozeTime(defaultSnoozeOption, timezone, morningTime, dayStart, timeSlots)
      )
    },
    [timezone, defaultSnoozeOption, bulkSnoozeDefault, timeSlots, morningTime, dayStart, dayKnown],
  )

  /**
   * One defer request for `ids`; resolves true when it went through.
   * `selected`: the ids ride in `include_task_ids` too. `suffix`: appended to
   * the toast's line (the selection's held-back counts).
   */
  const sendDefer = useCallback(
    async (
      ids: number[],
      snoozeUntil: string,
      { selected, suffix = '' }: { selected: boolean; suffix?: string },
    ): Promise<boolean> => {
      try {
        const res = await fetch('/api/tasks/bulk/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids,
            until: snoozeUntil,
            // A selection is deliberate: every selected task sent moves, High
            // and Urgent included — the multi-select edit's rule (`planQuickPanelSave`).
            ...(selected ? { include_task_ids: ids } : {}),
            // Defer is a DEFER (task queue, docs/TASK-MODEL.md § Picks and
            // defers): with the server switch on, one landing at or after the
            // next rollover is marked for the Tasks queue. This button is the
            // only web caller that sends it — every other bulk/snooze is a pick.
            source: 'sweep',
          }),
        })
        if (!res.ok) throw new Error('Defer failed')
        const responseData = await res.json()
        const tasksAffected = responseData.data?.tasks_affected ?? 0
        if (tasksAffected > 0) onUndoCountBump?.()
        fetchTasks()

        showToast({
          message: sweepToastMessage(responseData.data ?? {}) + suffix,
          type: 'success',
          action: tasksAffected > 0 ? { label: 'Undo', onClick: handleUndo } : undefined,
        })
        return true
      } catch {
        showToast({ message: 'Defer failed', type: 'error' })
        return false
      }
    },
    [fetchTasks, handleUndo, onUndoCountBump],
  )

  const snoozeOverdue = useCallback(
    async (until?: string) => {
      // THE overdue predicate (`isOverdue`), the one the trigger's badge
      // counts `displayTasks` with — so a press sweeps exactly the number on
      // the button. A quota is never late, so it is never swept.
      const overdueTasks = displayTasks.filter((t) => isOverdue(t, new Date()))
      if (overdueTasks.length === 0) {
        showToast({ message: `Nothing ${OVERDUE_LOWER}` })
        return
      }
      const snoozeUntil = resolveDeferTime(until)
      if (snoozeUntil === null) return
      await sendDefer(
        overdueTasks.map((t) => t.id),
        snoozeUntil,
        { selected: false },
      )
    },
    [displayTasks, resolveDeferTime, sendDefer],
  )

  const snoozeSelected = useCallback(
    async (until?: string) => {
      // Task rows only: the dashboard resolves the selection against
      // `visibleTasks`, so a reminder or a quota never reaches this.
      if (selectedTasks.length === 0) return
      const snoozeUntil = resolveDeferTime(until)
      if (snoozeUntil === null) return
      const split = splitSelectionDefer(selectedTasks, snoozeUntil)
      if (split.movers.length === 0) {
        showToast({ message: nothingToDeferMessage(split) })
        return
      }
      const sent = await sendDefer(
        split.movers.map((t) => t.id),
        snoozeUntil,
        { selected: true, suffix: selectionHeldBackSuffix(split) },
      )
      if (sent) onSelectedDone?.()
    },
    [selectedTasks, resolveDeferTime, sendDefer, onSelectedDone],
  )

  return { snoozeOverdue, snoozeSelected }
}

/** The bulk snooze response fields the toast reads. */
interface SweepResponse {
  summary?: string
  tasks_affected?: number
  skipped_urgent?: number
  skipped_high?: number
  snoozed_high?: number
  skipped_deadline?: number
  capped_deadline?: number
}

/**
 * The sweep toast's line: the server's standard `summary` (the task queue's
 * wording and names) when it sends one, else built here from the counts — an
 * older server's response.
 *
 * `skipped_urgent` is the TOTAL skipped on priority — its name is frozen by
 * the iOS client that reads it — and `skipped_high` is the High subset, so
 * Urgent alone is the difference. Falling back to the total when
 * `skipped_high` is absent keeps an older server's response readable: it
 * reports everything as Urgent, which is what that server meant by it.
 */
function sweepToastMessage(data: SweepResponse): string {
  if (data.summary) return data.summary
  const skippedByPriority = data.skipped_urgent ?? 0
  const skippedHigh = data.skipped_high ?? 0
  return bulkSnoozeMessage({
    affected: data.tasks_affected ?? 0,
    highAffected: data.snoozed_high ?? 0,
    high: skippedHigh,
    urgent: skippedByPriority - skippedHigh,
    deadline: data.skipped_deadline ?? 0,
    capped: data.capped_deadline ?? 0,
  })
}
