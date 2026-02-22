/**
 * Dismiss all notifications across all devices
 *
 * POST /api/notifications/dismiss-all
 *
 * Called when the user opens the app on any device (web, iOS, Watch).
 * Sends dismiss-all signals to all notification channels so notifications
 * clear everywhere, not just on the device the user opened.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { dismissAllNotifications } from '@/core/notifications/dismiss'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    dismissAllNotifications(user.id)
    return success({ dismissed: true })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/dismiss-all error:', err)
    return handleError(err)
  }
})
