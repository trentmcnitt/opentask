import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { endpoint, keys } = body
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return badRequest('Missing required fields: endpoint, keys.p256dh, keys.auth')
    }

    const db = getDb()

    // Upsert by endpoint — if same endpoint exists for any user, update it
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
    ).run(user.id, endpoint, keys.p256dh, keys.auth)

    return success({ subscribed: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/push/subscribe error:', err)
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { endpoint } = body
    if (!endpoint) {
      return badRequest('Missing required field: endpoint')
    }

    const db = getDb()
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(
      user.id,
      endpoint,
    )

    return success({ unsubscribed: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/push/subscribe error:', err)
    return handleError(err)
  }
}
