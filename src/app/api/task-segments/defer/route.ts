/**
 * Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
 *
 * POST /api/task-segments/defer — a task segment's Defer All: off today's
 * segment, back tomorrow. Stamps `segment_deferred_at`; NOT a consider, which
 * keeps "considered" honest. Body: { ids: [taskId, ...] }. One undo entry.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { deferTasks } from '@/core/tasks/task-segments'
import { validateSegmentIds } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids } = validateSegmentIds(await request.json())
    const n = deferTasks(user.id, ids)
    return success({ deferred: n, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/task-segments/defer error:', err)
    return handleError(err)
  }
})
