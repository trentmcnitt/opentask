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
      undoable_count: countUndoable(user.id),
      redoable_count: countRedoable(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/undo error:', err)
    return handleError(err)
  }
})
