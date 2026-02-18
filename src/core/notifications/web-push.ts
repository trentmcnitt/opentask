import webpush from 'web-push'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_EMAIL = process.env.VAPID_EMAIL || ''

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_EMAIL) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

interface PushPayload {
  title: string
  body: string
  data?: { url?: string; taskId?: number }
  tag?: string
}

interface PushSubscriptionRow {
  id: number
  endpoint: string
  p256dh: string
  auth: string
}

export function isWebPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_EMAIL)
}

export async function sendPushNotification(userId: number, payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) {
    log.warn('web-push', 'VAPID keys not configured, skipping push')
    return
  }

  const db = getDb()
  const subscriptions = db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as PushSubscriptionRow[]

  if (subscriptions.length === 0) return

  const jsonPayload = JSON.stringify(payload)

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          jsonPayload,
        )
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 410 || statusCode === 404) {
          // Subscription expired or invalid — remove it
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id)
          log.info('web-push', `Removed stale subscription ${sub.id} (${statusCode})`)
        } else {
          throw err
        }
      }
    }),
  )

  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    log.error(
      'web-push',
      `Failed to send ${failures.length}/${subscriptions.length} push notifications`,
    )
  }
}
