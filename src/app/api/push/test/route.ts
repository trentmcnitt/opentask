import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError } from '@/lib/api-response'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { APP_URL } from '@/core/notifications/format'

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
      test: true,
    })

    return success({ sent: true })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'POST /api/push/test error:', err)
    return handleError(err)
  }
})
