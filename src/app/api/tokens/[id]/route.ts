/**
 * API Token Revocation
 *
 * DELETE /api/tokens/:id — Revoke (hard delete) a token
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, forbidden, notFound, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { RouteContext } from '@/types/api'

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const user = await requireAuth(request)
    if (user.is_demo) {
      return forbidden('API tokens cannot be deleted in demo mode')
    }
    const { id } = await context.params
    const tokenId = parseInt(id)
    if (isNaN(tokenId)) {
      return notFound('Token not found')
    }

    const db = getDb()
    const result = db
      .prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?')
      .run(tokenId, user.id)

    if (result.changes === 0) {
      return notFound('Token not found')
    }

    return success({ deleted: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/tokens/:id error:', err)
    return handleError(err)
  }
})
