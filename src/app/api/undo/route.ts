/**
 * Undo API route
 *
 * POST /api/undo - Undo the last action
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { executeUndo, canUndo, countUndoable, countRedoable } from '@/core/undo'
import { syncBadgeCount } from '@/core/notifications/dismiss'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    // Optional session watermark for session-scoped counts
    let sessionStartId: number | undefined
    try {
      const body = await request.json()
      if (typeof body.session_start_id === 'number') {
        sessionStartId = body.session_start_id
      }
    } catch {
      // No body or invalid JSON — that's fine, counts will be all-time
    }

    if (!canUndo(user.id)) {
      return badRequest('Nothing to undo')
    }

    const result = executeUndo(user.id)

    if (!result) {
      return badRequest('Nothing to undo')
    }

    syncBadgeCount(user.id)

    return success({
      undone_action: result.undone_action,
      description: result.description,
      tasks_affected: result.tasks_affected,
      undoable_count: countUndoable(user.id, sessionStartId),
      redoable_count: countRedoable(user.id, sessionStartId),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/undo error:', err)
    return handleError(err)
  }
})
