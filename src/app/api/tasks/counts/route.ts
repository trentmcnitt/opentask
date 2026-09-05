/**
 * Task counts API
 *
 * GET /api/tasks/counts - { total, overdue, today } for the user's active tasks.
 *
 * Read by the nav badges on pages that do not load the task list (Reminders,
 * History, …). Computed over the same query the Tasks page server-renders
 * from, with the same pure function, so the two never disagree.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { formatTasksResponse } from '@/lib/format-task'
import { getTasks } from '@/core/tasks'
import { countTasks } from '@/lib/task-counts'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    // Same query the Tasks page server-renders from, minus reminders — the
    // page never counts those (§6: reminders are not debt), see the
    // `visibleTasks` filter in DashboardClient.
    const tasks = formatTasksResponse(getTasks({ userId: user.id, limit: 500 })).filter(
      (t) => !t.is_reminder,
    )
    return success(countTasks(tasks, user.timezone))
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/tasks/counts error:', err)
    return handleError(err)
  }
})
