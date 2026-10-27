/**
 * Undo Status API route
 *
 * GET /api/undo/status - Returns session init data: latest undo ID + counts
 *
 * `latest_id` is the newest entry of any kind, undone ones included (the web's
 * session watermark). `newest_undoable_id` (2026-10-26) is the entry a bare
 * undo would take next and `next_redoable_id` the one a bare redo would —
 * what a native surface compares its own last `undo_id` with before it
 * offers Undo or Redo (`POST /api/undo { id }`). Each is null when there is
 * none.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import {
  getLatestUndoId,
  getNewestUndoableId,
  getNextRedoableId,
  countUndoable,
  countRedoable,
} from '@/core/undo'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    return success({
      latest_id: getLatestUndoId(user.id),
      undoable_count: countUndoable(user.id),
      redoable_count: countRedoable(user.id),
      newest_undoable_id: getNewestUndoableId(user.id),
      next_redoable_id: getNextRedoableId(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/undo/status error:', err)
    return handleError(err)
  }
})
