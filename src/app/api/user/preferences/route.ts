/**
 * User preferences API
 *
 * GET  /api/user/preferences - Get user preferences
 * PATCH /api/user/preferences - Update user preferences
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'

const VALID_GROUPINGS = ['time', 'project'] as const

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    // Read from DB directly — the JWT may have a stale value
    const db = getDb()
    const row = db.prepare('SELECT default_grouping FROM users WHERE id = ?').get(user.id) as
      | { default_grouping: string }
      | undefined

    return success({
      default_grouping: row?.default_grouping ?? 'project',
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    return handleError(err)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const body = await request.json()

    if (body.default_grouping !== undefined && !VALID_GROUPINGS.includes(body.default_grouping)) {
      return badRequest('default_grouping must be "time" or "project"')
    }

    if (body.default_grouping === undefined) {
      return badRequest('No preferences to update')
    }

    const db = getDb()
    db.prepare('UPDATE users SET default_grouping = ? WHERE id = ?').run(
      body.default_grouping,
      user.id,
    )

    return success({
      default_grouping: body.default_grouping,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    return handleError(err)
  }
}
