import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    if (!isWebPushConfigured()) {
      return success({ sent: false, reason: 'VAPID keys not configured' })
    }

    await sendPushNotification(user.id, {
      title: 'OpenTask',
      body: 'Test push notification — tap to open OpenTask',
      data: { url: APP_URL },
    })

    return success({ sent: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/push/test error:', err)
    return handleError(err)
  }
})
