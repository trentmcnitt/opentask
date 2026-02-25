/**
 * Batch Redo API route
 *
 * POST /api/redo/batch - Redo multiple actions atomically
 *
 * Accepts one of:
 * - { through_id } — redo entries up to and including this ID
 * - { count } — redo a specific number of entries
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError, handleZodError } from '@/lib/api-response'
import { executeBatchRedo } from '@/core/undo'
import { syncBadgeCount } from '@/core/notifications/dismiss'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { z, ZodError } from 'zod'

const batchRedoSchema = z
  .object({
    through_id: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
  })
  .refine((d) => d.through_id !== undefined || d.count !== undefined, {
    message: 'Must provide through_id or count',
  })

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const { through_id, count } = batchRedoSchema.parse(body)

    const result = executeBatchRedo(user.id, {
      throughId: through_id,
      count,
    })

    if (result.count === 0) {
      return badRequest('Nothing to redo')
    }

    syncBadgeCount(user.id)

    return success({
      count: result.count,
      undoable_count: result.remaining_undoable,
      redoable_count: result.remaining_redoable,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/redo/batch error:', err)
    return handleError(err)
  }
})
