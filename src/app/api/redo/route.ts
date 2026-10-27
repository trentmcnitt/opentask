/**
 * Redo API route
 *
 * POST /api/redo - Redo the last undone action
 *
 * Body (optional): `{ session_start_id?: number, id?: number }`.
 *
 * - No `id`: redo the entry a bare redo takes (the oldest undone one — the
 *   last one undone), whoever made it.
 * - `id` (2026-10-26, scoped native Undo, `POST /api/undo`'s twin): redo only
 *   if that entry is the one a bare redo would take (`redoNext`, checked
 *   inside the transaction), else a 409 `CONFLICT` with `details: { reason,
 *   next_redoable_id }` — `reason` `not_next` (another undone entry comes
 *   first), `not_undone` (it is live: redone already, or never undone), or
 *   `gone` (purged, cleared by a newer action, or not this user's) — and
 *   nothing changes.
 *
 * The success body carries `redone_id`, the entry redone, with or without `id`.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, conflict, handleError } from '@/lib/api-response'
import { redoNext, countUndoable, countRedoable } from '@/core/undo'
import { log } from '@/lib/logger'
import { parseUndoBody } from '@/lib/undo-body'
import { withLogging } from '@/lib/with-logging'

const CONFLICT_MESSAGES = {
  not_next: 'That action is not the next one to redo',
  not_undone: 'That action is not undone',
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

    const outcome = redoNext(user.id, id)

    if (outcome.status === 'conflict') {
      return conflict(CONFLICT_MESSAGES[outcome.reason], {
        reason: outcome.reason,
        next_redoable_id: outcome.next_redoable_id,
      })
    }
    if (outcome.status === 'empty') {
      return badRequest('Nothing to redo')
    }

    return success({
      redone_action: outcome.result.redone_action,
      description: outcome.result.description,
      tasks_affected: outcome.result.tasks_affected,
      redone_id: outcome.id,
      undoable_count: countUndoable(user.id, sessionStartId),
      redoable_count: countRedoable(user.id, sessionStartId),
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'POST /api/redo error:', err)
    return handleError(err)
  }
})
