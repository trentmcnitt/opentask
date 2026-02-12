/**
 * Shared hook for the "snooze all overdue" action.
 *
 * Used by both the dashboard and project detail pages. Sends overdue task IDs
 * to the bulk snooze endpoint and shows a toast with results.
 *
 * Two-tier snooze: first click snoozes P0/P1 (tier 1), second click with
 * remaining IDs snoozes P2 (tier 2). P3/P4 are always skipped.
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
  timezone: string
  defaultSnoozeOption: string
  morningTime: string
}

/**
 * Build a comma-separated skip breakdown string from per-priority counts.
 * Only includes non-zero entries. Returns empty string if nothing was skipped.
 */
function buildSkipBreakdown(medium: number, high: number, urgent: number): string {
  const parts: string[] = []
  if (medium > 0) parts.push(`${medium} medium`)
  if (high > 0) parts.push(`${high} high`)
  if (urgent > 0) parts.push(`${urgent} urgent`)
  return parts.join(', ')
}

/**
 * Returns a callback that snoozes all overdue tasks from `displayTasks`.
 *
 * Sends all overdue task IDs to the server — the server handles the two-tier
 * priority filtering. The optional `until` parameter allows SnoozeAllFab
 * long-press menu to override the default duration.
 */
export function useSnoozeOverdue(options: UseSnoozeOverdueOptions) {
  const { displayTasks, fetchTasks, handleUndo, timezone, defaultSnoozeOption, morningTime } =
    options

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
        const tier = responseData.data?.tier ?? 0
        const skippedMedium = responseData.data?.skipped_medium ?? 0
        const skippedHigh = responseData.data?.skipped_high ?? 0
        const skippedUrgent = responseData.data?.skipped_urgent ?? 0
        fetchTasks()

        const skipBreakdown = buildSkipBreakdown(skippedMedium, skippedHigh, skippedUrgent)
        const skipSuffix = skipBreakdown ? ` (${skipBreakdown} skipped)` : ''

        let message: string
        if (tasksAffected === 0) {
          // Nothing eligible (tier 0)
          const mustSnooze = buildSkipBreakdown(skippedMedium, skippedHigh, skippedUrgent)
          message = `No snoozable tasks (${mustSnooze} must be snoozed individually)`
        } else if (tier === 2) {
          message = `Snoozed ${tasksAffected} medium ${taskWord(tasksAffected)}${skipSuffix}`
        } else {
          message = `Snoozed ${tasksAffected} ${taskWord(tasksAffected)}${skipSuffix}`
        }

        showToast({
          message,
          action: tasksAffected > 0 ? { label: 'Undo', onClick: handleUndo } : undefined,
        })
      } catch {
        showToast({ message: 'Snooze failed' })
      }
    },
    [displayTasks, fetchTasks, handleUndo, timezone, defaultSnoozeOption, morningTime],
  )
}
