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

/**
 * Shared helper that handles the common APNs device-send pattern:
 * look up devices, send via Promise.allSettled, clean stale tokens, log failures.
 *
 * @param userId - User whose devices to send to
 * @param buildNotification - Callback that builds the notification for each device
 * @param logLabel - Label for failure log messages (e.g., "notification", "badge update")
 * @param preLog - Optional callback for pre-send logging, receives the device list
 */
async function sendToAllDevices(
  userId: number,
  buildNotification: (device: ApnsDeviceRow) => Notification | SilentNotification,
  logLabel: string,
  preLog?: (devices: ApnsDeviceRow[]) => void,
): Promise<void> {
  if (!isApnsConfigured()) return

  const db = getDb()
  const devices = db
    .prepare('SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?')
    .all(userId) as ApnsDeviceRow[]

  if (devices.length === 0) return

  if (preLog) preLog(devices)

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const notification = buildNotification(device)

      try {
        const apns = getClient(device.environment)
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
      `Failed to send ${failures.length}/${devices.length} APNs ${logLabel}: ${reasons}`,
    )
  }
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
 * Per-class notification threads (REDESIGN-V03 §4.2).
 *
 * A single thread ID meant every notification piled into one visible stack, so
 * an urgent item and a routine one were indistinguishable at a glance. Separate
 * threads make iOS group them as separate stacks.
 *
 * Splitting urgent from ordinary tasks is the point: the whole redesign is
 * about the interruption surface staying constant as volume grows, and a
 * stack you can triage by looking at it is the visual half of that.
 */
export const NOTIFICATION_THREADS = {
  /** §6 Reminders — the time slot notifies, not the item. */
  reminders: 'ot-reminders',
  /** Ordinary overdue tasks (P0–P3). */
  tasks: 'ot-tasks',
  /** P4 — breaks through everything, so it gets its own stack. */
  urgent: 'ot-urgent',
} as const

/** Which thread a task notification belongs to, by priority. */
export function threadIdForPriority(priority: number): string {
  return priority >= 4 ? NOTIFICATION_THREADS.urgent : NOTIFICATION_THREADS.tasks
}

/**
 * Send a push notification to all APNs devices for a user.
 * Cleans up stale device tokens automatically.
 */
export async function sendApnsNotification(
  userId: number,
  payload: ApnsPushPayload,
): Promise<void> {
  const isCritical = payload.interruptionLevel === 'critical'

  await sendToAllDevices(
    userId,
    (device) =>
      new Notification(device.device_token, {
        alert: { title: payload.title, body: payload.body },
        topic: device.bundle_id,
        category: 'TASK_REMINDER',
        // §4.2: urgent gets its own visible stack so it can't be lost among
        // routine items.
        threadId: threadIdForPriority(payload.priority),
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
      }),
    'notifications',
    (devices) => {
      const bundleIds = devices.map((d) => d.bundle_id).join(', ')
      log.info(
        'apns',
        `Sending notification for task ${payload.taskId} to ${devices.length} device(s) [${bundleIds}]`,
      )
    },
  )
}

/**
 * Send a summary notification to all APNs devices.
 * Used when a consolidation bucket overflows its individual notification cap.
 *
 * Uses the TASK_SUMMARY category so iOS shows bulk-snooze action buttons
 * and the content extension can display the snooze grid in bulk mode.
 */
export async function sendApnsSummaryNotification(
  userId: number,
  title: string,
  body: string,
  overflowCount: number,
  totalOverdueCount: number,
): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) =>
      new Notification(device.device_token, {
        alert: { title, body },
        topic: device.bundle_id,
        category: 'TASK_SUMMARY',
        threadId: NOTIFICATION_THREADS.tasks,
        sound: 'default',
        collapseId: 'overdue-summary',
        data: {
          overflowCount,
          totalOverdueCount,
        },
      }),
    'summary notifications',
  )
}

/**
 * The §6 time-slot reminder push — one notification per slot, never per item.
 *
 * Carries the slot identity (not the items) because the content extension
 * fetches the live list from `GET /api/reminders` when the user long-presses:
 * a payload snapshot taken at slot time would already be stale by the time the
 * checklist is read, and completing a stale row is exactly the kind of quiet
 * wrongness this surface cannot afford.
 *
 * userInfo contract with `OpenTaskNotification` (snake_case, matching the API
 * fields the extension filters on):
 * - `slot_id` — time_slots.id, or -1 for the un-slotted group
 * - `slot_label` — display label, used as the checklist header
 * - `reminder_count` — pending count at send time (header fallback only)
 *
 * `collapseId` is per-slot, so a later push for the same slot REPLACES the
 * earlier one rather than stacking: the slot's banner always shows the current
 * count (§4.2 class-level collapse).
 */
export interface ApnsSlotReminderPayload {
  slotId: number
  slotLabel: string
  count: number
}

export async function sendApnsSlotReminder(
  userId: number,
  payload: ApnsSlotReminderPayload,
): Promise<void> {
  const body = payload.count === 1 ? '1 reminder waiting' : `${payload.count} reminders waiting`

  await sendToAllDevices(
    userId,
    (device) =>
      new Notification(device.device_token, {
        alert: { title: payload.slotLabel, body },
        topic: device.bundle_id,
        category: 'SLOT_REMINDER',
        threadId: NOTIFICATION_THREADS.reminders,
        sound: 'default',
        collapseId: `slot-${payload.slotId}`,
        data: {
          slot_id: payload.slotId,
          slot_label: payload.slotLabel,
          reminder_count: payload.count,
        },
        aps: {
          // Reminders carry no debt (§6) — they must never interrupt like an
          // overdue task does.
          'interruption-level': 'active',
        },
      }),
    'slot reminders',
    (devices) => {
      log.info(
        'apns',
        `Sending slot reminder "${payload.slotLabel}" (${payload.count}) to ${devices.length} device(s)`,
      )
    },
  )
}

/**
 * Send a silent push that updates the app icon badge number.
 * Called after mutations that change the overdue count (via dismiss module)
 * and by the cron for users who have overdue tasks but didn't get visible
 * notifications that cycle.
 *
 * iOS ignores the aps.badge field in pushes without an alert, so we send the
 * badge count in the data payload. The AppDelegate's didReceiveRemoteNotification
 * handler reads the count and calls setBadgeCount() programmatically.
 */
export async function sendApnsBadgeUpdate(userId: number, badge: number): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) =>
      new SilentNotification(device.device_token, {
        topic: device.bundle_id,
        collapseId: 'badge-update',
        data: { type: 'badge-update', badge },
      }),
    'badge updates',
  )
}

/**
 * Dismiss notifications for specific tasks on all iOS devices for a user.
 * Sends a silent push with a dismiss signal that the app handles by clearing
 * matching delivered notifications.
 */
export async function dismissApnsNotifications(userId: number, taskIds: number[]): Promise<void> {
  if (taskIds.length === 0) return

  await sendToAllDevices(
    userId,
    (device) =>
      new SilentNotification(device.device_token, {
        topic: device.bundle_id,
        data: { type: 'dismiss', taskIds },
      }),
    'dismiss signals',
    (devices) => {
      const bundleIds = devices.map((d) => d.bundle_id).join(', ')
      log.info(
        'apns',
        `Dismiss: sending silent push for tasks [${taskIds.join(',')}] to ${devices.length} device(s) [${bundleIds}]`,
      )
    },
  )
}

/**
 * Dismiss ALL notifications on all iOS devices for a user.
 * Used when the user opens the app on any device — clears notification noise everywhere.
 * Sends a silent push with type "dismiss-all" that the app handles by clearing
 * all delivered notifications.
 */
export async function dismissAllApnsNotifications(userId: number): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) =>
      new SilentNotification(device.device_token, {
        topic: device.bundle_id,
        data: { type: 'dismiss-all' },
      }),
    'dismiss-all signals',
    (devices) => {
      const bundleIds = devices.map((d) => d.bundle_id).join(', ')
      log.info(
        'apns',
        `Dismiss-all: sending silent push to ${devices.length} device(s) [${bundleIds}]`,
      )
    },
  )
}
