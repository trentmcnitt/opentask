/**
 * Test notification API
 *
 * POST /api/notifications/test
 * Body: { type: 'individual' | 'high' | 'bulk' | 'critical' }
 *
 * Sends a test notification of the requested type via Web Push (and Pushover for critical).
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''
const PUSHOVER_USER = process.env.PUSHOVER_USER || ''
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

const VALID_TYPES = ['individual', 'high', 'bulk', 'critical'] as const
type TestType = (typeof VALID_TYPES)[number]

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const type = body.type as string
    if (!VALID_TYPES.includes(type as TestType)) {
      return badRequest(`type must be one of: ${VALID_TYPES.join(', ')}`)
    }

    if (!isWebPushConfigured()) {
      return badRequest('Web Push is not configured (VAPID keys missing)')
    }

    if (type === 'individual') {
      await sendPushNotification(user.id, {
        title: 'Test: Individual Notification',
        body: 'This is a test notification from OpenTask.',
        data: { url: APP_URL },
      })
    } else if (type === 'high') {
      await sendPushNotification(user.id, {
        title: 'Test: HIGH: Important Task',
        body: 'This is a test high-priority notification.',
        data: { url: APP_URL },
      })
    } else if (type === 'bulk') {
      await sendPushNotification(user.id, {
        title: 'Test: 3 overdue tasks',
        body: '- Buy groceries\n- Call dentist\n- Review notes',
        data: { url: `${APP_URL}/?filter=overdue` },
      })
    } else if (type === 'critical') {
      // Send Web Push (test sends both channels; production critical alerts only send Pushover)
      await sendPushNotification(user.id, {
        title: 'Test: URGENT Alert',
        body: 'This is a test urgent/critical alert from OpenTask.',
        data: { url: APP_URL },
      })

      // Send Pushover if configured
      const db = getDb()
      const config = db
        .prepare('SELECT pushover_user_key, pushover_sound FROM users WHERE id = ?')
        .get(user.id) as { pushover_user_key: string | null; pushover_sound: string } | undefined

      const pushoverUser = config?.pushover_user_key || PUSHOVER_USER
      const pushoverSound = config?.pushover_sound || 'echo'
      if (PUSHOVER_TOKEN && pushoverUser) {
        await sendTestPushover(pushoverUser, pushoverSound)
      }
    }

    return success({ sent: true, type })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/test error:', err)
    return handleError(err)
  }
}

async function sendTestPushover(pushoverUser: string, sound: string): Promise<void> {
  const params = new URLSearchParams({
    token: PUSHOVER_TOKEN,
    user: pushoverUser,
    title: 'Test: URGENT Alert',
    message: 'This is a test urgent/critical alert from OpenTask.',
    priority: '2',
    retry: '300',
    expire: '3600',
    sound,
    url: APP_URL,
    url_title: 'Open OpenTask',
  })

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: params,
  })
  if (!res.ok) {
    throw new Error(`Pushover returned ${res.status}: ${await res.text()}`)
  }
}
