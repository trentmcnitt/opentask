/**
 * Redo API route
 *
 * POST /api/redo - Redo the last undone action
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { executeRedo, canRedo, countUndoable, countRedoable } from '@/core/undo'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    if (!canRedo(user.id)) {
      return badRequest('Nothing to redo')
    }

    const result = executeRedo(user.id)

    if (!result) {
      return badRequest('Nothing to redo')
    }

    return success({
      redone_action: result.redone_action,
      description: result.description,
      tasks_affected: result.tasks_affected,
      undoable_count: countUndoable(user.id),
      redoable_count: countRedoable(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/redo error:', err)
    return handleError(err)
  }
}
