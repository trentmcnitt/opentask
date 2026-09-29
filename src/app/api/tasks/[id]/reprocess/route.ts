/**
 * Reprocess API route
 *
 * POST /api/tasks/:id/reprocess - Retry AI enrichment for a failed task
 *
 * Swaps the `ai-failed` label to `ai-to-process` (atomic + undo-logged),
 * then fires off enrichment in the background.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, handleError, parseRouteId } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { reprocessTask } from '@/core/tasks'
import { isAIEnabled, enrichSingleTask } from '@/core/ai'
import { log } from '@/lib/logger'
import type { RouteContext } from '@/types/api'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')

    const task = reprocessTask({
      userId: user.id,
      taskId,
    })

    // Fire-and-forget: trigger immediate enrichment
    if (isAIEnabled()) {
      enrichSingleTask(task.id, user.id).catch((err) => {
        log.error('api', `Fire-and-forget reprocess enrichment failed for task ${task.id}:`, err)
      })
    }

    return success(formatTaskResponse(task))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/:id/reprocess error:', err)
    return handleError(err)
  }
})
