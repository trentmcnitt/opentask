/**
 * Bulk Snooze Overdue API route
 *
 * POST /api/tasks/bulk/snooze-overdue - Snooze all overdue P0/P1 tasks for the user
 *
 * Server-side convenience for the iOS "All" button — no task IDs needed from client.
 * Queries overdue tasks, applies two-tier filtering via bulkSnooze().
 *
 * Body: { delta_minutes: number }
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { bulkSnooze } from '@/core/tasks'
import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { dismissApnsNotifications } from '@/core/notifications/apns'
import { validateBulkSnoozeOverdue } from '@/core/validation'
import { log } from '@/lib/logger'
import { getDb } from '@/core/db'
import { ZodError } from 'zod'

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const input = validateBulkSnoozeOverdue(body)

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

    if (taskIds.length === 0) {
      return success({
        tasks_affected: 0,
        tasks_skipped: 0,
        tier: 0,
        skipped_medium: 0,
        skipped_high: 0,
        skipped_urgent: 0,
      })
    }

    // bulkSnooze handles two-tier filtering internally (P0/P1 first, then P2)
    const result = bulkSnooze({
      userId: user.id,
      userTimezone: user.timezone,
      taskIds,
      deltaMinutes: input.delta_minutes,
    })

    // Dismiss notifications for snoozed tasks (fire-and-forget)
    // Re-query snoozed IDs from what we know was affected — use the overdue task IDs
    // since bulkSnooze filtered internally. Best-effort: dismiss all overdue IDs.
    dismissTaskNotifications(user.id, taskIds).catch((err) =>
      log.error('api', 'Dismiss notification error:', err),
    )
    dismissApnsNotifications(user.id, taskIds).catch((err) =>
      log.error('api', 'Dismiss APNs notification error:', err),
    )

    return success({
      tasks_affected: result.tasksAffected,
      tasks_skipped: result.tasksSkipped,
      tier: result.tier,
      skipped_medium: result.skippedByPriority.medium,
      skipped_high: result.skippedByPriority.high,
      skipped_urgent: result.skippedByPriority.urgent,
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
}
