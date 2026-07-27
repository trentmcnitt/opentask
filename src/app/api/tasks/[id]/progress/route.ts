/**
 * Task progress API (REDESIGN-V03 §5)
 *
 * POST /api/tasks/:id/progress - Log progress on a tracked task (default +1)
 *
 * Deliberately separate from the completion endpoints. A sub-target increment
 * is NOT a completion: it dispatches `task.progressed`, and the task stays open
 * until its period boundary so overflow (3/2) remains observable.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { incrementProgress } from '@/core/tasks/progress'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { z, ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

const progressSchema = z.object({
  /** Defaults to +1. Negative corrects a mis-log. */
  delta: z.number().int().min(-100).max(100).default(1),
})

export const POST = withLogging(async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params

    // An empty body is the common case (a +1 tap), so tolerate no JSON at all.
    const body = await request.json().catch(() => ({}))
    const { delta } = progressSchema.parse(body)

    const { task, met, description } = incrementProgress({
      userId: user.id,
      taskId: parseInt(id),
      delta,
    })

    return success({ ...formatTaskResponse(task), met, description })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/tasks/:id/progress error:', err)
    return handleError(err)
  }
})
