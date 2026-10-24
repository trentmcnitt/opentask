/**
 * Shared hook for the "snooze all overdue" action.
 *
 * Used by the dashboard. Sends overdue task IDs to the bulk snooze endpoint
 * and shows a toast with results.
 *
 * P0-P2 are always eligible. P3 (High) joins in once nothing lower is left in
 * the batch, so a list of nothing but overdue High tasks takes two presses
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
import { nextPeriodStart, type TimeSlot } from '@/lib/time-slot-assign'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'
import { useDayStart, useDayStartKnown } from '@/components/PreferencesProvider'

interface UseSnoozeOverdueOptions {
  displayTasks: Task[]
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
 * Returns a callback that snoozes all overdue tasks from `displayTasks`.
 *
 * Sends all overdue task IDs to the server — the server handles priority
 * filtering (see the block comment above). The optional `until` parameter
 * allows the snooze-all trigger's long-press menu to override the default duration.
 */
export function useSnoozeOverdue(options: UseSnoozeOverdueOptions) {
  const {
    displayTasks,
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

  return useCallback(
    async (until?: string) => {
      const now = new Date()
      // THE overdue predicate (`isOverdue`), the one the trigger's badge
      // counts `displayTasks` with — so a press sweeps exactly the number on
      // the button. A quota is never late, so it is never swept.
      const overdueTasks = displayTasks.filter((t) => isOverdue(t, now))

      if (overdueTasks.length === 0) {
        showToast({ message: `Nothing ${OVERDUE_LOWER}` })
        return
      }

      // A plain press goes to the NEXT PERIOD by default (Trent, 2026-09-22:
      // "I want the default bulk snooze... to default to next period"), with a
      // setting to flip back to the default snooze option. With no slots there
      // is no next period, so the option is the fallback either way.
      const nextPeriod =
        bulkSnoozeDefault === 'next_period' ? nextPeriodStart(timeSlots, timezone, now) : null
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
        return
      }
      const snoozeUntil =
        until ??
        nextPeriod ??
        computeSnoozeTime(defaultSnoozeOption, timezone, morningTime, dayStart, timeSlots)

      try {
        const res = await fetch('/api/tasks/bulk/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: overdueTasks.map((t) => t.id),
            until: snoozeUntil,
            // Snooze-all is a DEFER (task queue, docs/TASK-MODEL.md § Picks
            // and defers): with the server switch on, one landing at or after
            // the next rollover is marked for the Tasks queue. The only web
            // caller that sends it — every other bulk/snooze is a pick.
            source: 'sweep',
          }),
        })
        if (!res.ok) throw new Error('Defer failed')
        const responseData = await res.json()
        const tasksAffected = responseData.data?.tasks_affected ?? 0
        if (tasksAffected > 0) onUndoCountBump?.()
        fetchTasks()

        const message = sweepToastMessage(responseData.data ?? {})

        showToast({
          message,
          type: 'success',
          action: tasksAffected > 0 ? { label: 'Undo', onClick: handleUndo } : undefined,
        })
      } catch {
        showToast({ message: 'Defer failed', type: 'error' })
      }
    },
    [
      displayTasks,
      fetchTasks,
      handleUndo,
      onUndoCountBump,
      timezone,
      defaultSnoozeOption,
      bulkSnoozeDefault,
      timeSlots,
      morningTime,
      dayStart,
      dayKnown,
    ],
  )
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
