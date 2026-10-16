/**
 * Quota progress history API (2026-10-16)
 *
 * GET /api/tasks/:id/progress-events?since=&until=&limit=&before_id= — every
 * +1/−1 logged against a quota, newest first, with where it came from
 * (`source`: web, widget, watch, mac, api — or undo/redo, the opposite row an
 * undo or redo of a count writes). `since` is inclusive and `until` exclusive
 * (ISO datetimes); at most `limit` rows (default and maximum 500), with
 * `has_more` and `before_id` paging back. Owner or shared-project access, as
 * for the task itself. See `getProgressEvents`.
 */

import { NextRequest } from 'next/server'
import { z, ZodError } from 'zod'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, handleError, handleZodError, parseRouteId } from '@/lib/api-response'
import { getProgressEvents, PROGRESS_EVENTS_LIMIT } from '@/core/tasks/quotas'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

const querySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(PROGRESS_EVENTS_LIMIT).optional(),
  before_id: z.coerce.number().int().positive().optional(),
})

export const GET = withLogging(async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')
    const params = request.nextUrl.searchParams
    const query = querySchema.parse({
      since: params.get('since') ?? undefined,
      until: params.get('until') ?? undefined,
      limit: params.get('limit') ?? undefined,
      before_id: params.get('before_id') ?? undefined,
    })
    return success(
      getProgressEvents(user.id, taskId, {
        since: query.since,
        until: query.until,
        limit: query.limit,
        beforeId: query.before_id,
      }),
    )
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError))
      log.error('api', 'GET /api/tasks/:id/progress-events error:', err)
    return handleError(err)
  }
})
