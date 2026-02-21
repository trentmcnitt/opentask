/**
 * Test notification API
 *
 * POST /api/notifications/test
 * Body: { type: 'individual' | 'high' | 'bulk' | 'critical' }
 *
 * Creates a real temporary task and sends notifications to ALL channels
 * (Web Push + APNs) after a 3-second delay. The delay gives the user time
 * to switch away from the tab so the service worker doesn't suppress the
 * web push notification.
 *
 * Because it's a real task, tapping Done/Snooze on any device triggers
 * cross-device notification dismissal — a true end-to-end test.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'
import { createTask } from '@/core/tasks'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'

const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

const VALID_TYPES = ['individual', 'high', 'bulk', 'critical'] as const
type TestType = (typeof VALID_TYPES)[number]

const SEND_DELAY_MS = 3000

/** Priority value for each test type */
const TYPE_PRIORITY: Record<TestType, number> = {
  individual: 0,
  high: 3,
  bulk: 0,
  critical: 4,
}

/** Title prefix for each test type */
const TYPE_TITLE: Record<TestType, string> = {
  individual: 'Test notification',
  high: 'Test high priority',
  bulk: 'Test notification',
  critical: 'Test urgent alert',
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const type = body.type as string
    if (!VALID_TYPES.includes(type as TestType)) {
      return badRequest(`type must be one of: ${VALID_TYPES.join(', ')}`)
    }

    const testType = type as TestType
    const webPushEnabled = isWebPushConfigured()
    const apnsEnabled = isApnsConfigured()

    if (!webPushEnabled && !apnsEnabled) {
      return badRequest('No notification channels configured')
    }

    const priority = TYPE_PRIORITY[testType]

    // Create a real task so actions (Done/Snooze) and cross-device dismiss work
    const dueAt = new Date(Date.now() - 60_000).toISOString() // 1 minute ago
    const task = createTask({
      userId: user.id,
      userTimezone: user.timezone,
      input: {
        title: TYPE_TITLE[testType],
        due_at: dueAt,
        priority,
        labels: ['test'],
      },
    })

    // Fire notifications after delay (gives user time to switch away from tab).
    // Fire-and-forget — don't block the API response.
    const taskId = task.id
    const userId = user.id
    setTimeout(async () => {
      try {
        const sends: Promise<void>[] = []
        const priorityLabel =
          priority >= 4 ? 'URGENT: ' : priority >= HIGH_PRIORITY_THRESHOLD ? 'HIGH: ' : ''
        const title = `${priorityLabel}${task.title}`

        // Web Push
        if (webPushEnabled) {
          sends.push(
            sendPushNotification(userId, {
              title,
              body: 'Test notification — tap an action to test cross-device dismiss',
              data: { url: `${APP_URL}/?task=${taskId}`, taskId },
            }),
          )
        }

        // APNs (all devices — iPhone + Watch)
        if (apnsEnabled) {
          sends.push(
            sendApnsNotification(userId, {
              title,
              body: 'Test notification',
              taskId,
              dueAt: task.due_at!,
              priority,
              overdueCount: 0,
              interruptionLevel: priority >= HIGH_PRIORITY_THRESHOLD ? 'time-sensitive' : 'active',
            }),
          )
        }

        await Promise.allSettled(sends)
        log.info('notifications', `Test ${testType} notification sent for task ${taskId}`)
      } catch (err) {
        log.error('notifications', `Test notification send error:`, err)
      }
    }, SEND_DELAY_MS)

    return success({
      sent: true,
      type: testType,
      task_id: taskId,
      delay_seconds: SEND_DELAY_MS / 1000,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/test error:', err)
    return handleError(err)
  }
}
