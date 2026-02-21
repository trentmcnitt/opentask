/**
 * Batch Undo API route
 *
 * POST /api/undo/batch - Undo multiple actions atomically
 *
 * Accepts one of:
 * - { session_start_id } — undo all entries after this ID (session scope)
 * - { through_id } — undo entries down to and including this ID
 * - { count } — undo a specific number of entries
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError, handleZodError } from '@/lib/api-response'
import { executeBatchUndo } from '@/core/undo'
import { log } from '@/lib/logger'
import { z, ZodError } from 'zod'

const batchUndoSchema = z
  .object({
    session_start_id: z.number().int().positive().optional(),
    through_id: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
  })
  .refine(
    (d) => d.session_start_id !== undefined || d.through_id !== undefined || d.count !== undefined,
    {
      message: 'Must provide session_start_id, through_id, or count',
    },
  )

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const { session_start_id, through_id, count } = batchUndoSchema.parse(body)

    const result = executeBatchUndo(user.id, {
      sessionStartId: session_start_id,
      throughId: through_id,
      count,
    })

    if (result.count === 0) {
      return badRequest('Nothing to undo')
    }

    return success({
      count: result.count,
      undoable_count: result.remaining_undoable,
      redoable_count: result.remaining_redoable,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/undo/batch error:', err)
    return handleError(err)
  }
}
