/**
 * Shared hook for the "snooze all overdue" action.
 *
 * Used by both the dashboard and project detail pages. Sends overdue task IDs
 * to the bulk snooze endpoint and shows a toast with results.
 *
 * P0-P3 tasks are eligible for bulk snooze. P4 (Urgent) is excluded.
 */

import { useCallback } from 'react'
import type { Task } from '@/types'
import { showToast } from '@/lib/toast'
import { computeSnoozeTime } from '@/lib/snooze'
import { taskWord } from '@/lib/utils'

interface UseSnoozeOverdueOptions {
  displayTasks: Task[]
  fetchTasks: () => void
  handleUndo: () => void
  onUndoCountBump?: () => void
  timezone: string
  defaultSnoozeOption: string
  morningTime: string
}

/**
 * Returns a callback that snoozes all overdue tasks from `displayTasks`.
 *
 * Sends all overdue task IDs to the server — the server handles priority
 * filtering (P0-P3 eligible, P4 excluded). The optional `until` parameter
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
    morningTime,
  } = options

  return useCallback(
    async (until?: string) => {
      const now = new Date()
      const overdueTasks = displayTasks.filter((t) => t.due_at && new Date(t.due_at) < now)

      if (overdueTasks.length === 0) {
        showToast({ message: 'No overdue tasks' })
        return
      }

      const snoozeUntil = until ?? computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)

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
        const skippedUrgent = responseData.data?.skipped_urgent ?? 0
        if (tasksAffected > 0) onUndoCountBump?.()
        fetchTasks()

        const skipSuffix = skippedUrgent > 0 ? ` (${skippedUrgent} urgent skipped)` : ''

        let message: string
        if (tasksAffected === 0) {
          message = `No snoozable tasks (${skippedUrgent} urgent must be snoozed individually)`
        } else {
          message = `Snoozed ${tasksAffected} ${taskWord(tasksAffected)}${skipSuffix}`
        }

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
      morningTime,
    ],
  )
}
