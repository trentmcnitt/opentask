/**
 * Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
 *
 * POST /api/task-segments/restore — put a considered or deferred row back
 * (2026-10-11, "Show considered"): clears `last_considered_at` and
 * `segment_deferred_at`, so the row waits again. Body: { ids: [taskId, ...] }.
 * One undo entry for all of them.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { restoreTasks } from '@/core/tasks/task-segments'
import { validateSegmentIds } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids } = validateSegmentIds(await request.json())
    const n = restoreTasks(user.id, ids)
    return success({ restored: n, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/task-segments/restore error:', err)
    return handleError(err)
  }
})
