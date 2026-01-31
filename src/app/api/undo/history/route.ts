/**
 * Undo History API route
 *
 * GET /api/undo/history - Get recent undo history
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { getUndoHistory } from '@/core/undo'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { searchParams } = new URL(request.url)
    let limit = 50
    if (searchParams.has('limit')) {
      limit = parseInt(searchParams.get('limit')!)
      if (isNaN(limit) || limit < 1) {
        return handleError(new Error('Invalid limit parameter'))
      }
    }

    const history = getUndoHistory(user.id, limit)

    return success({
      history: history.map((entry) => ({
        id: entry.id,
        action: entry.action,
        description: entry.description,
        tasks_affected: entry.snapshot.length,
        created_at: entry.created_at,
        undone: entry.undone,
      })),
      count: history.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('GET /api/undo/history error:', err)
    return handleError(err)
  }
}
