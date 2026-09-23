/**
 * WidgetKit Push Token Registration API route
 *
 * POST /api/push/apns/widget-token - Register a widget extension's push token
 * DELETE /api/push/apns/widget-token - Unregister a widget push token
 *
 * Distinct from POST/DELETE /api/push/apns/register (apns_devices): a widget
 * push token belongs to the WIDGET EXTENSION process, not the app, and is
 * sent with apns-push-type "widgets" to a different APNs topic — see
 * docs/NOTIFICATIONS.md and src/core/notifications/apns.ts (sendApnsWidgetReload).
 *
 * Body (POST): { push_token: string, bundle_id: string, platform: 'ios' | 'macos',
 *                 environment?: string, widget_kind?: string }
 * Body (DELETE): { push_token: string }
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { push_token, bundle_id, platform, environment, widget_kind } = body
    if (!push_token || typeof push_token !== 'string') {
      return badRequest('Missing required field: push_token')
    }
    if (!bundle_id || typeof bundle_id !== 'string') {
      return badRequest('Missing required field: bundle_id')
    }
    if (platform !== 'ios' && platform !== 'macos') {
      return badRequest('platform must be "ios" or "macos"')
    }
    if (widget_kind !== undefined && widget_kind !== null && typeof widget_kind !== 'string') {
      return badRequest('widget_kind must be a string')
    }

    const env = environment === 'development' ? 'development' : 'production'

    const db = getDb()
    db.prepare(
      `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, widget_kind, environment, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(push_token) DO UPDATE SET
         user_id = excluded.user_id,
         bundle_id = excluded.bundle_id,
         platform = excluded.platform,
         widget_kind = excluded.widget_kind,
         environment = excluded.environment,
         updated_at = excluded.updated_at`,
    ).run(user.id, push_token, bundle_id, platform, widget_kind ?? null, env)

    return success({ registered: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/push/apns/widget-token error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(request: NextRequest) {
  try {
    await requireAuth(request)
    const body = await request.json()

    const { push_token } = body
    if (!push_token || typeof push_token !== 'string') {
      return badRequest('Missing required field: push_token')
    }

    // Delete by push_token only — same reasoning as DELETE /api/push/apns/register:
    // possessing the token implies device/extension ownership, and the caller
    // (WidgetPushRegistrar on an empty `widgets` array — the last widget was
    // removed) has no other identity to authenticate against.
    const db = getDb()
    db.prepare('DELETE FROM widget_push_tokens WHERE push_token = ?').run(push_token)

    return success({ unregistered: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/push/apns/widget-token error:', err)
    return handleError(err)
  }
})
