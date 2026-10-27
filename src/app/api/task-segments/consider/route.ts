/**
 * Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
 *
 * POST /api/task-segments/consider — a task segment's circle: "I saw it."
 * Stamps `last_considered_at`; never a completion. Body: { ids: [taskId, ...] }.
 * One undo entry for all of them, logged even when a task is already
 * considered today (so the toast's Undo never reaches an older action).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { considerTasks } from '@/core/tasks/task-segments'
import { validateSegmentIds } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids } = validateSegmentIds(await request.json())
    const n = considerTasks(user.id, ids)
    return success({ considered: n, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/task-segments/consider error:', err)
    return handleError(err)
  }
})
