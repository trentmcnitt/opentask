/**
 * APNs Device Registration API route
 *
 * POST /api/push/apns/register - Register an iOS device for push notifications
 * DELETE /api/push/apns/register - Unregister a device
 *
 * Body (POST): { device_token: string, bundle_id: string, environment?: string }
 * Body (DELETE): { device_token: string }
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { device_token, bundle_id, environment } = body
    if (!device_token || typeof device_token !== 'string') {
      return badRequest('Missing required field: device_token')
    }
    if (!bundle_id || typeof bundle_id !== 'string') {
      return badRequest('Missing required field: bundle_id')
    }

    const env = environment === 'development' ? 'development' : 'production'

    const db = getDb()
    db.prepare(
      `INSERT INTO apns_devices (user_id, device_token, bundle_id, environment)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_token) DO UPDATE SET
         user_id = excluded.user_id,
         bundle_id = excluded.bundle_id,
         environment = excluded.environment`,
    ).run(user.id, device_token, bundle_id, env)

    return success({ registered: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/push/apns/register error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { device_token } = body
    if (!device_token || typeof device_token !== 'string') {
      return badRequest('Missing required field: device_token')
    }

    const db = getDb()
    db.prepare('DELETE FROM apns_devices WHERE user_id = ? AND device_token = ?').run(
      user.id,
      device_token,
    )

    return success({ unregistered: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/push/apns/register error:', err)
    return handleError(err)
  }
}
