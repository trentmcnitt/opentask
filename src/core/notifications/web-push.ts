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
  test?: boolean
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

/**
 * Send a raw payload to all push subscriptions for a user.
 * Shared between regular notifications and dismiss signals.
 * Cleans up stale subscriptions (410/404) automatically.
 */
async function sendToAllSubscriptions(userId: number, jsonPayload: string): Promise<void> {
  const db = getDb()
  const subscriptions = db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as PushSubscriptionRow[]

  if (subscriptions.length === 0) return

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

export async function sendPushNotification(userId: number, payload: PushPayload): Promise<void> {
  if (!isWebPushConfigured()) {
    log.warn('web-push', 'VAPID keys not configured, skipping push')
    return
  }
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) as c FROM push_subscriptions WHERE user_id = ?').get(userId) as {
      c: number
    }
  ).c
  log.info('web-push', `Sending notification to ${count} subscription(s) for user ${userId}`)
  await sendToAllSubscriptions(userId, JSON.stringify(payload))
}

/**
 * Dismiss notifications for specific tasks across all user devices.
 * Sends a special push message that the service worker handles by closing
 * matching notifications instead of showing a new one.
 * Fire-and-forget — failures are logged but don't affect the caller.
 */
export async function dismissTaskNotifications(userId: number, taskIds: number[]): Promise<void> {
  if (!isWebPushConfigured() || taskIds.length === 0) return
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) as c FROM push_subscriptions WHERE user_id = ?').get(userId) as {
      c: number
    }
  ).c
  log.info(
    'web-push',
    `Dismiss: sending for tasks [${taskIds.join(',')}] to ${count} subscription(s)`,
  )
  await sendToAllSubscriptions(userId, JSON.stringify({ type: 'dismiss', taskIds }))
}

/**
 * Dismiss ALL notifications across all user devices.
 * Used when the user opens the app on any device — clears notification noise everywhere.
 */
export async function dismissAllWebPushNotifications(userId: number): Promise<void> {
  if (!isWebPushConfigured()) return
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) as c FROM push_subscriptions WHERE user_id = ?').get(userId) as {
      c: number
    }
  ).c
  if (count === 0) return
  log.info('web-push', `Dismiss-all: sending to ${count} subscription(s) for user ${userId}`)
  await sendToAllSubscriptions(userId, JSON.stringify({ type: 'dismiss-all' }))
}
