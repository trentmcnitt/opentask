/**
 * GET /api/auth/me
 *
 * Returns the authenticated user's info.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)

    if (!user) {
      return unauthorized()
    }

    return success({
      id: user.id,
      email: user.email,
      name: user.name,
      timezone: user.timezone,
      default_grouping: user.default_grouping,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/auth/me error:', err)
    return handleError(err)
  }
}
