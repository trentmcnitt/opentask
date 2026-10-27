/**
 * Undo API route
 *
 * POST /api/undo - Undo the last action
 *
 * Body (optional): `{ session_start_id?: number, id?: number }`.
 *
 * - No `id`: undo the newest not-undone entry, whoever made it — the web's
 *   global Undo, and every native build before scoped Undo.
 * - `id` (2026-10-26, scoped native Undo): undo only if that entry is the one
 *   a bare undo would take (`undoLatest`, checked inside the transaction).
 *   A widget or the watch sends the `undo_id` its own last action answered,
 *   so its Undo never reverses another device's action. Anything else is a
 *   409 `CONFLICT` with `details: { reason, newest_undoable_id }` — `reason`
 *   `not_latest` (something newer was logged since), `already_undone`, or
 *   `gone` (purged, or not this user's) — and nothing changes. An `id` on an
 *   empty log is a 409 too, never the bare form's 400.
 *
 * The success body carries `undone_id`, the entry undone, with or without `id`.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, conflict, handleError } from '@/lib/api-response'
import { undoLatest, countUndoable, countRedoable } from '@/core/undo'
import { log } from '@/lib/logger'
import { parseUndoBody } from '@/lib/undo-body'
import { withLogging } from '@/lib/with-logging'

const CONFLICT_MESSAGES = {
  not_latest: 'Something newer has happened since; that action is no longer the last one',
  already_undone: 'That action was already undone',
  gone: 'That action is no longer in the undo history',
} as const

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await parseUndoBody(request)
    if ('error' in body) return badRequest(body.error)
    const { sessionStartId, id } = body

    const outcome = undoLatest(user.id, id)

    if (outcome.status === 'conflict') {
      return conflict(CONFLICT_MESSAGES[outcome.reason], {
        reason: outcome.reason,
        newest_undoable_id: outcome.newest_undoable_id,
      })
    }
    if (outcome.status === 'empty') {
      return badRequest('Nothing to undo')
    }

    return success({
      undone_action: outcome.result.undone_action,
      description: outcome.result.description,
      tasks_affected: outcome.result.tasks_affected,
      undone_id: outcome.id,
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
