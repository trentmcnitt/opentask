/**
 * Pushover user key validation API
 *
 * POST /api/notifications/validate-pushover
 * Body: { user_key: string }
 *
 * Validates a Pushover user key against the Pushover API and returns
 * whether it's valid along with the user's device list.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request)
    const body = await request.json()

    const userKey = body.user_key
    if (typeof userKey !== 'string' || !userKey.trim()) {
      return badRequest('user_key is required')
    }

    if (!PUSHOVER_TOKEN) {
      return badRequest('Pushover is not configured on this server (missing app token)')
    }

    const params = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: userKey.trim(),
    })

    const response = await fetch('https://api.pushover.net/1/users/validate.json', {
      method: 'POST',
      body: params,
    })

    const data = await response.json()

    if (data.status === 1) {
      return success({ valid: true, devices: data.devices || [] })
    }

    return success({ valid: false, error: data.errors?.join(', ') || 'Invalid user key' })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/validate-pushover error:', err)
    return handleError(err)
  }
}
