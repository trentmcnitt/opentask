/**
 * Aged out (2026-10-29, first pass — src/lib/aged-out.ts)
 *
 * POST /api/task-segments/grow — an Aged out row's Grow: each task's horizon
 * one step out (Days → Weeks → Months → Eventually; unset → Months), its keep
 * count back to 0, and the row considered today. Body: { ids: [taskId, ...] }.
 * One undo entry. 404 unless the build has the segment (`NEXT_PUBLIC_AGED_OUT`).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError, notFound } from '@/lib/api-response'
import { growTasks } from '@/core/tasks/task-segments'
import { validateSegmentIds } from '@/core/validation'
import { AGED_OUT_ENABLED } from '@/lib/aged-out'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    if (!AGED_OUT_ENABLED) return notFound('Not found')
    const user = await requireAuth(request)
    const { ids } = validateSegmentIds(await request.json())
    const n = growTasks(user.id, user.timezone, ids)
    return success({ grown: n, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/task-segments/grow error:', err)
    return handleError(err)
  }
})
