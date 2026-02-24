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

/**
 * Separate clients for production and development (sandbox) APNs endpoints.
 * Debug/direct-to-device builds register as "development" and require the sandbox
 * endpoint; TestFlight/App Store builds register as "production".
 */
const clients: Record<string, ApnsClient> = {}

function getClient(environment: string): ApnsClient {
  if (!clients[environment]) {
    const signingKey = readFileSync(APNS_KEY_PATH, 'utf8')
    clients[environment] = new ApnsClient({
      team: APNS_TEAM_ID,
      keyId: APNS_KEY_ID,
      signingKey,
      defaultTopic: APNS_BUNDLE_ID,
      host: environment === 'development' ? Host.development : Host.production,
    })
  }
  return clients[environment]
}

export function isApnsConfigured(): boolean {
  return Boolean(APNS_KEY_ID && APNS_TEAM_ID && APNS_KEY_PATH && APNS_BUNDLE_ID)
}

interface ApnsDeviceRow {
  id: number
  device_token: string
  bundle_id: string
  environment: string
}

/** Error reasons that indicate the device token is no longer valid. */
const STALE_TOKEN_REASONS: Set<string> = new Set([Errors.badDeviceToken, Errors.unregistered])

function isStaleTokenError(err: unknown): boolean {
  const reason = (err as ApnsError)?.reason
  return typeof reason === 'string' && STALE_TOKEN_REASONS.has(reason)
}

export interface ApnsPushPayload {
  title: string
  body: string
  taskId: number
  dueAt: string
  priority: number
  overdueCount: number
  /** App icon badge number — total overdue tasks for the user */
  badge?: number
  /** 'time-sensitive' for P3+, 'active' for P0-P2. 'critical' reserved for when Apple approves the entitlement. */
  interruptionLevel: 'time-sensitive' | 'active' | 'critical'
  /** Volume for critical alerts (0.0-1.0). Only used when interruptionLevel is 'critical'. */
  criticalAlertVolume?: number
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
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const bundleIds = devices.map((d) => d.bundle_id).join(', ')
  log.info(
    'apns',
    `Sending notification for task ${payload.taskId} to ${devices.length} device(s) [${bundleIds}]`,
  )

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const apns = getClient(device.environment)
      const isCritical = payload.interruptionLevel === 'critical'
      const notification = new Notification(device.device_token, {
        alert: { title: payload.title, body: payload.body },
        topic: device.bundle_id,
        category: 'TASK_REMINDER',
        threadId: 'opentask-overdue',
        badge: payload.badge,
        sound: isCritical
          ? { critical: 1, name: 'default', volume: payload.criticalAlertVolume ?? 1.0 }
          : 'default',
        collapseId: `task-${payload.taskId}`,
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

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const reasons = failures.map((f) => (f.reason as ApnsError)?.reason ?? f.reason).join(', ')
    log.error(
      'apns',
      `Failed to send ${failures.length}/${devices.length} APNs notifications: ${reasons}`,
    )
  }
}

/**
 * Send a summary notification (no interactive actions) to all APNs devices.
 * Used when a consolidation bucket overflows its individual notification cap.
 * Tapping opens the app — no snooze grid.
 */
export async function sendApnsSummaryNotification(
  userId: number,
  title: string,
  body: string,
): Promise<void> {
  if (!isApnsConfigured()) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const apns = getClient(device.environment)
      const notification = new Notification(device.device_token, {
        alert: { title, body },
        topic: device.bundle_id,
        threadId: 'opentask-overdue',
        sound: 'default',
        collapseId: 'overdue-summary',
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

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const reasons = failures.map((f) => (f.reason as ApnsError)?.reason ?? f.reason).join(', ')
    log.error(
      'apns',
      `Failed to send ${failures.length}/${devices.length} APNs summary notifications: ${reasons}`,
    )
  }
}

/**
 * Send a silent push that only updates the app icon badge number.
 * Called on every cron cycle when there are overdue tasks, even if no
 * visible notifications fire (so the badge stays current).
 * Uses content-available:1 with no alert/sound — iOS delivers silently.
 */
export async function sendApnsBadgeUpdate(userId: number, badge: number): Promise<void> {
  if (!isApnsConfigured()) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const apns = getClient(device.environment)
      const notification = new Notification(device.device_token, {
        topic: device.bundle_id,
        badge,
        collapseId: 'badge-update',
        aps: { 'content-available': 1 },
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

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const reasons = failures.map((f) => (f.reason as ApnsError)?.reason ?? f.reason).join(', ')
    log.error(
      'apns',
      `Failed to send ${failures.length}/${devices.length} badge updates: ${reasons}`,
    )
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
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) {
    log.info('apns', `Dismiss: no devices registered for user ${userId}`)
    return
  }

  const bundleIds = devices.map((d) => d.bundle_id).join(', ')
  log.info(
    'apns',
    `Dismiss: sending silent push for tasks [${taskIds.join(',')}] to ${devices.length} device(s) [${bundleIds}]`,
  )

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const apns = getClient(device.environment)
      const notification = new SilentNotification(device.device_token, {
        topic: device.bundle_id,
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

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const reasons = failures.map((f) => (f.reason as ApnsError)?.reason ?? f.reason).join(', ')
    log.error(
      'apns',
      `Failed to send ${failures.length}/${devices.length} APNs dismiss signals: ${reasons}`,
    )
  }
}

/**
 * Dismiss ALL notifications on all iOS devices for a user.
 * Used when the user opens the app on any device — clears notification noise everywhere.
 * Sends a silent push with type "dismiss-all" that the app handles by clearing
 * all delivered notifications.
 */
export async function dismissAllApnsNotifications(userId: number): Promise<void> {
  if (!isApnsConfigured()) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  const bundleIds = devices.map((d) => d.bundle_id).join(', ')
  log.info('apns', `Dismiss-all: sending silent push to ${devices.length} device(s) [${bundleIds}]`)

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const apns = getClient(device.environment)
      const notification = new SilentNotification(device.device_token, {
        topic: device.bundle_id,
        data: { type: 'dismiss-all' },
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

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    const reasons = failures.map((f) => (f.reason as ApnsError)?.reason ?? f.reason).join(', ')
    log.error(
      'apns',
      `Failed to send ${failures.length}/${devices.length} APNs dismiss-all signals: ${reasons}`,
    )
  }
}
