/**
 * Test notification API
 *
 * POST /api/notifications/test
 * Body: { type: 'individual' | 'high' | 'bulk' | 'critical' }
 *
 * Sends a test notification of the requested type via Web Push (and APNs for critical).
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'

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
      // Web Push
      await sendPushNotification(user.id, {
        title: 'Test: URGENT Alert',
        body: 'This is a test urgent/critical alert from OpenTask.',
        data: { url: APP_URL },
      })

      // APNs time-sensitive (if configured)
      if (isApnsConfigured()) {
        await sendApnsNotification(user.id, {
          title: 'Test: URGENT Alert',
          body: 'This is a test urgent/critical alert from OpenTask.',
          taskId: 0,
          dueAt: new Date().toISOString(),
          priority: 4,
          overdueCount: 0,
          interruptionLevel: 'time-sensitive',
        })
      }
    }

    return success({ sent: true, type })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/test error:', err)
    return handleError(err)
  }
}
