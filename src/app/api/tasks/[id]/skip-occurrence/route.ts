/**
 * Skip occurrence API (REDESIGN-V03 §7.5)
 *
 * POST /api/tasks/:id/skip-occurrence
 *
 * Named `skip-occurrence` rather than `skip` because `review/execute` already
 * uses "skip" for a no-op review acknowledgment — a different operation (§6.0
 * terminology guard).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, handleError, parseRouteId } from '@/lib/api-response'
import { skipOccurrence } from '@/core/tasks/skip'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const { task, wasRecurring, description } = skipOccurrence({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
    })

    return success({ ...formatTaskResponse(task), was_recurring: wasRecurring, description })
  } catch (err) {
    if (!(err instanceof AppError))
      log.error('api', 'POST /api/tasks/:id/skip-occurrence error:', err)
    return handleError(err)
  }
})
