/**
 * Task provenance confirmation (REDESIGN-V03 §7.2)
 *
 * POST /api/tasks/:id/confirm - Bless a task the assistant created on its own
 * initiative: removes `ai-proposed`, adds `ai-added`. The logic lives in
 * `confirmTaskProvenance` (`src/core/tasks/confirm.ts`).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError, ForbiddenError } from '@/core/errors'
import { success, badRequest, notFound, handleError, parseRouteId } from '@/lib/api-response'
import { confirmTaskProvenance } from '@/core/tasks'
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

    const { task, confirmed } = confirmTaskProvenance(user.id, user.timezone, taskId)
    return success({ ...formatTaskResponse(task), confirmed })
  } catch (err) {
    // A task the user can't access answers 404, like a missing one — this
    // endpoint doesn't reveal that the id exists.
    if (err instanceof ForbiddenError) return notFound('Task not found')
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/:id/confirm error:', err)
    return handleError(err)
  }
})
