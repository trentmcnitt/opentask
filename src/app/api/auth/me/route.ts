/**
 * GET /api/auth/me
 *
 * Returns the authenticated user's info.
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { success, unauthorized } from '@/lib/api-response'

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request)

  if (!user) {
    return unauthorized()
  }

  return success({
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
  })
}
