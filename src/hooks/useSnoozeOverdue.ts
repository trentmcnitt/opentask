/**
 * Shared hook for the "snooze all overdue" action.
 *
 * Used by both the dashboard and project detail pages. Sends overdue task IDs
 * to the bulk snooze endpoint and shows a toast with results.
 *
 * P0-P2 are always eligible. P3 (High) joins in once nothing lower is left in
 * the batch, so a list of nothing but overdue High tasks takes two presses
 * rather than refusing to move. P4 (Urgent) is never bulk-snoozed. The rule
 * lives in `filterForBulkSnooze`; the server decides, this hook only reports.
 */

import { useCallback } from 'react'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'
import { showToast } from '@/lib/toast'
import { bulkSnoozeMessage, computeSnoozeTime } from '@/lib/snooze'
import { nextPeriodStart, type TimeSlot } from '@/lib/time-slot-assign'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'

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
 * allows SnoozeAllFab long-press menu to override the default duration.
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

  return useCallback(
    async (until?: string) => {
      const now = new Date()
      // Same predicate the badge counts with (`countTasks`): a quota is never
      // late, so it is never swept. Without this the header read "0 overdue"
      // while the button beside it snoozed every quota.
      const overdueTasks = displayTasks.filter(
        (t) => t.due_at && new Date(t.due_at) < now && !isTracked(t),
      )

      if (overdueTasks.length === 0) {
        showToast({ message: 'No overdue tasks' })
        return
      }

      // A plain press goes to the NEXT PERIOD by default (Trent, 2026-09-22:
      // "I want the default bulk snooze... to default to next period"), with a
      // setting to flip back to the default snooze option. With no slots there
      // is no next period, so the option is the fallback either way.
      const nextPeriod =
        bulkSnoozeDefault === 'next_period' ? nextPeriodStart(timeSlots, timezone, now) : null
      const snoozeUntil =
        until ?? nextPeriod ?? computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)

      try {
        const res = await fetch('/api/tasks/bulk/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: overdueTasks.map((t) => t.id),
            until: snoozeUntil,
          }),
        })
        if (!res.ok) throw new Error('Snooze failed')
        const responseData = await res.json()
        const tasksAffected = responseData.data?.tasks_affected ?? 0
        // `skipped_urgent` is the TOTAL skipped on priority — its name is frozen
        // by the iOS client that reads it — and `skipped_high` is the High
        // subset, so Urgent alone is the difference. Falling back to the total
        // when `skipped_high` is absent keeps an older server's response
        // readable: it reports everything as Urgent, which is what that server
        // meant by it.
        const skippedByPriority = responseData.data?.skipped_urgent ?? 0
        const skippedHigh = responseData.data?.skipped_high ?? 0
        const snoozedHigh = responseData.data?.snoozed_high ?? 0
        if (tasksAffected > 0) onUndoCountBump?.()
        fetchTasks()

        const message = bulkSnoozeMessage({
          affected: tasksAffected,
          highAffected: snoozedHigh,
          high: skippedHigh,
          urgent: skippedByPriority - skippedHigh,
        })

        showToast({
          message,
          type: 'success',
          action: tasksAffected > 0 ? { label: 'Undo', onClick: handleUndo } : undefined,
        })
      } catch {
        showToast({ message: 'Snooze failed', type: 'error' })
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
    ],
  )
}
