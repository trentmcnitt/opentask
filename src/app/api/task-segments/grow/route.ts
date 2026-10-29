/**
 * Aged out (2026-10-29, first pass — src/lib/aged-out.ts)
 *
 * POST /api/task-segments/grow — an Aged out row's Grow: each task's horizon
 * one step out (Days → Weeks → Months → Eventually; unset → Months), its keep
 * count back to 0, and the row considered today. Body: { ids: [taskId, ...],
 * horizon? } — `horizon` (the button's hold menu) moves each task to that
 * horizon instead of one step.
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
import { z, ZodError } from 'zod'
import { HORIZON_ORDER } from '@/lib/task-segments'
import { requestUndoId } from '@/core/request-context'

/** The hold menu's pick: a horizon (never unset — choosing unset is not a grow). */
const GROW_TO = z.enum(HORIZON_ORDER).optional()

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    if (!AGED_OUT_ENABLED) return notFound('Not found')
    const user = await requireAuth(request)
    const body = await request.json()
    const { ids } = validateSegmentIds(body)
    const to = GROW_TO.parse((body as { horizon?: unknown }).horizon)
    const n = growTasks(user.id, user.timezone, ids, to)
    return success({ grown: n, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/task-segments/grow error:', err)
    return handleError(err)
  }
})
