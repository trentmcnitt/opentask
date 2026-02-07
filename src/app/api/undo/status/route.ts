/**
 * Undo Status API route
 *
 * GET /api/undo/status - Returns session init data: latest undo ID + counts
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { getLatestUndoId, countUndoable, countRedoable } from '@/core/undo'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    return success({
      latest_id: getLatestUndoId(user.id),
      undoable_count: countUndoable(user.id),
      redoable_count: countRedoable(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/undo/status error:', err)
    return handleError(err)
  }
}
