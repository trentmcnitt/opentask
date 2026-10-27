/**
 * The deadlines page (2026-10-22, docs/TASK-MODEL.md § The deadlines page)
 *
 * POST /api/task-segments/defer-lead — a deadlines-page row's Defer: moves
 * THIS instance's lead day (`lead_from`) to `day`, so the row leaves the page
 * until then. Body: { ids: [taskId, ...], day? } — `day` the OpenTask day
 * (yyyy-MM-dd), from tomorrow to two days before the deadline's day; omitted
 * = tomorrow. Refused per task (never the whole request) once the safety net
 * holds it (from the day before the deadline), for a later day, or for a task
 * that is not a deadline task with no target. One undo entry for the tasks it
 * moved. 409 when the server's task queue is off.
 *
 * Response: { day, deferred, refused: [{ id, reason, message }], summary }.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { deferLeads } from '@/core/tasks/task-segments'
import { validateDeferLead } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids, day } = validateDeferLead(await request.json())
    const result = deferLeads(user.id, user.timezone, ids, day)
    return success({ ...result, undo_id: requestUndoId() })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) {
      log.error('api', 'POST /api/task-segments/defer-lead error:', err)
    }
    return handleError(err)
  }
})
