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
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { executeBatchRedo } from '@/core/undo'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()
    const { through_id, count } = body as {
      through_id?: number
      count?: number
    }

    if (through_id === undefined && count === undefined) {
      return badRequest('Must provide through_id or count')
    }

    const result = executeBatchRedo(user.id, {
      throughId: through_id,
      count,
    })

    if (result.count === 0) {
      return badRequest('Nothing to redo')
    }

    return success({
      count: result.count,
      undoable_count: result.remaining_undoable,
      redoable_count: result.remaining_redoable,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/redo/batch error:', err)
    return handleError(err)
  }
}
