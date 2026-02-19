/**
 * APNs (Apple Push Notification service) module for iOS native app
 *
 * Mirrors the web-push.ts pattern: lazy singleton client, send/dismiss/isConfigured.
 * Uses token-based auth with a p8 key file.
 *
 * Auto-cleans stale device tokens on BadDeviceToken/Unregistered errors.
 * The `interruption-level` field is set via the raw `aps` dict since the apns2
 * library doesn't have a convenience property for it.
 */

import { ApnsClient, Host, Notification, SilentNotification, Errors } from 'apns2'
import type { ApnsError } from 'apns2'
import { readFileSync } from 'fs'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const APNS_KEY_ID = process.env.APNS_KEY_ID || ''
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || ''
const APNS_KEY_PATH = process.env.APNS_KEY_PATH || ''
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || ''

let client: ApnsClient | null = null

function getClient(): ApnsClient {
  if (!client) {
    const signingKey = readFileSync(APNS_KEY_PATH, 'utf8')
    client = new ApnsClient({
      team: APNS_TEAM_ID,
      keyId: APNS_KEY_ID,
      signingKey,
      defaultTopic: APNS_BUNDLE_ID,
      host: Host.production,
    })
  }
  return client
}

export function isApnsConfigured(): boolean {
  return Boolean(APNS_KEY_ID && APNS_TEAM_ID && APNS_KEY_PATH && APNS_BUNDLE_ID)
}

interface ApnsDeviceRow {
  id: number
  device_token: string
  environment: string
}

/** Error reasons that indicate the device token is no longer valid. */
const STALE_TOKEN_REASONS = new Set([Errors.badDeviceToken, Errors.unregistered])

function isStaleTokenError(err: unknown): boolean {
  const reason = (err as ApnsError)?.reason
  return typeof reason === 'string' && STALE_TOKEN_REASONS.has(reason as never)
}

export interface ApnsPushPayload {
  title: string
  body: string
  taskId: number
  dueAt: string
  priority: number
  overdueCount: number
  /** 'time-sensitive' for P3/P4, 'active' for P0-P2 */
  interruptionLevel: 'time-sensitive' | 'active'
}

/**
 * Send a push notification to all APNs devices for a user.
 * Cleans up stale device tokens automatically.
 */
export async function sendApnsNotification(
  userId: number,
  payload: ApnsPushPayload,
): Promise<void> {
  if (!isApnsConfigured()) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const apns = getClient()

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const notification = new Notification(device.device_token, {
        alert: { title: payload.title, body: payload.body },
        category: 'TASK_REMINDER',
        threadId: 'opentask-overdue',
        sound: 'default',
        data: {
          taskId: payload.taskId,
          dueAt: payload.dueAt,
          priority: payload.priority,
          overdueCount: payload.overdueCount,
        },
        aps: {
          'interruption-level': payload.interruptionLevel,
        },
      })

      try {
        await apns.send(notification)
      } catch (err: unknown) {
        if (isStaleTokenError(err)) {
          db.prepare('DELETE FROM apns_devices WHERE id = ?').run(device.id)
          log.info('apns', `Removed stale device token ${device.id}`)
        } else {
          throw err
        }
      }
    }),
  )

  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    log.error('apns', `Failed to send ${failures.length}/${devices.length} APNs notifications`)
  }
}

/**
 * Dismiss notifications for specific tasks on all iOS devices for a user.
 * Sends a silent push with a dismiss signal that the app handles by clearing
 * matching delivered notifications.
 */
export async function dismissApnsNotifications(userId: number, taskIds: number[]): Promise<void> {
  if (!isApnsConfigured() || taskIds.length === 0) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const apns = getClient()

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const notification = new SilentNotification(device.device_token, {
        data: { type: 'dismiss', taskIds },
      })

      try {
        await apns.send(notification)
      } catch (err: unknown) {
        if (isStaleTokenError(err)) {
          db.prepare('DELETE FROM apns_devices WHERE id = ?').run(device.id)
          log.info('apns', `Removed stale device token ${device.id}`)
        } else {
          throw err
        }
      }
    }),
  )

  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    log.error('apns', `Failed to send ${failures.length}/${devices.length} APNs dismiss signals`)
  }
}
