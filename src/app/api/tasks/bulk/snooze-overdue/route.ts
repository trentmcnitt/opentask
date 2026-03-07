/**
 * Bulk Snooze Overdue API route
 *
 * POST /api/tasks/bulk/snooze-overdue - Snooze all overdue tasks for the user
 *
 * Server-side convenience for the iOS "All" button — no task IDs needed from client.
 * Queries overdue tasks, applies priority filtering via bulkSnooze() (P0-P3 eligible,
 * P4 Urgent excluded).
 *
 * Computes an absolute snooze target from now (not relative to each task's due_at):
 * - { delta_minutes: 30 }  → 30 min from now (exact, < 60 min)
 * - { delta_minutes: 60 }  → 1 hour from now, snapped to nearest hour
 * - { until: "ISO8601" }   → explicit absolute target
 * - {} (empty body)        → user's default_snooze_option preference
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { validateBulkSnoozeOverdue } from '@/core/validation'
import { computeSnoozeTime } from '@/lib/snooze'
import { log } from '@/lib/logger'
import { getDb } from '@/core/db'
import { ZodError } from 'zod'
import { withLogging } from '@/lib/with-logging'
import { notifyDemoEngagement } from '@/lib/demo-notify'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const input = validateBulkSnoozeOverdue(body)

    // Compute absolute snooze target from now
    let until: string
    if (input.until) {
      until = input.until
    } else {
      // Use delta_minutes from request, or fall back to user's default_snooze_option
      const db = getDb()
      const prefs = db
        .prepare('SELECT default_snooze_option, morning_time FROM users WHERE id = ?')
        .get(user.id) as { default_snooze_option: string; morning_time: string }

      const option = input.delta_minutes ? String(input.delta_minutes) : prefs.default_snooze_option

      until = computeSnoozeTime(option, user.timezone, prefs.morning_time)
    }

    // Query all overdue, active tasks for this user
    const db = getDb()
    const overdueTasks = db
      .prepare(
        `SELECT id FROM tasks
         WHERE user_id = ?
           AND done = 0
           AND deleted_at IS NULL
           AND archived_at IS NULL
           AND due_at IS NOT NULL
           AND datetime(due_at) < datetime('now')
         ORDER BY due_at ASC`,
      )
      .all(user.id) as { id: number }[]

    const taskIds = overdueTasks.map((t) => t.id)

    // Merge in explicitly included task IDs (e.g., the P4 task the user is acting on)
    const includeTaskIds = input.include_task_ids
    if (includeTaskIds?.length) {
      const existing = new Set(taskIds)
      for (const id of includeTaskIds) {
        if (!existing.has(id)) {
          taskIds.push(id)
        }
      }
    }

    if (taskIds.length === 0) {
      return success({
        tasks_affected: 0,
        tasks_skipped: 0,
        skipped_urgent: 0,
      })
    }

    // bulkSnooze handles priority filtering internally (P0-P3 eligible, P4 excluded
    // unless explicitly included via includeTaskIds)
    const result = bulkSnooze({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds,
      until,
      includeTaskIds,
    })

    // Dismiss only the tasks that were actually snoozed, not tasks that were
    // skipped by priority filtering (P4 Urgent may still be overdue).
    if (result.tasksAffected > 0) {
      const stillOverdue = db
        .prepare(
          `SELECT id FROM tasks
           WHERE user_id = ?
             AND done = 0
             AND deleted_at IS NULL
             AND archived_at IS NULL
             AND due_at IS NOT NULL
             AND datetime(due_at) < datetime('now')`,
        )
        .all(user.id) as { id: number }[]
      const stillOverdueIds = new Set(stillOverdue.map((t) => t.id))
      const snoozedIds = taskIds.filter((id) => !stillOverdueIds.has(id))
      dismissNotificationsForTasks(user.id, snoozedIds)
    }

    notifyDemoEngagement(user.name, 'update')
    return success({
      tasks_affected: result.tasksAffected,
      tasks_skipped: result.tasksSkipped,
      skipped_urgent: result.urgentSkipped,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    if (err instanceof ZodError) {
      return handleZodError(err)
    }
    log.error('api', 'POST /api/tasks/bulk/snooze-overdue error:', err)
    return handleError(err)
  }
})
