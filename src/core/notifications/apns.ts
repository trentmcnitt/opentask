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

import { ApnsClient, Host, Notification, SilentNotification, Errors, Priority } from 'apns2'
import type { ApnsError, PushType } from 'apns2'
import { readFileSync } from 'fs'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { forgetBadgeSent, recordBadgeSent } from '@/core/notifications/badge-state'

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

function isBadDeviceTokenError(err: unknown): boolean {
  return (err as ApnsError)?.reason === Errors.badDeviceToken
}

/**
 * Send on the environment the device registered with; if APNs answers
 * BadDeviceToken, try the OTHER environment once before giving the token up.
 *
 * Why: BadDeviceToken is what APNs returns for a sandbox token sent to the
 * production host (and vice versa), and the app's claimed environment can be
 * wrong. The iOS apps chose it with `#if DEBUG`, but a Release build installed
 * straight to a device is signed with `aps-environment: development`, so it
 * gets SANDBOX tokens while registering as "production". Every send was then
 * refused and the server deleted the registration — two users'
 * iPhones silently stopped receiving push on 2026-09-27 (the Mac hit the same
 * thing earlier; see WebViewHost.swift). Trusting APNs over the client's
 * claim heals such a row on its next send, with no app update.
 *
 * Returns the environment the send succeeded on (the caller persists a
 * change), or throws the error from the last attempt.
 */
async function sendTryingBothEnvironments(
  environment: string,
  notification: Notification | SilentNotification,
): Promise<string> {
  try {
    await getClient(environment).send(notification)
    return environment
  } catch (err: unknown) {
    if (!isBadDeviceTokenError(err)) throw err
    const other = environment === 'development' ? 'production' : 'development'
    await getClient(other).send(notification)
    return other
  }
}

/**
 * Shared helper that handles the common APNs device-send pattern:
 * look up devices, send via Promise.allSettled, clean stale tokens, log failures.
 *
 * @param userId - User whose devices to send to
 * @param buildNotification - Callback that builds the notification for each device
 * @param logLabel - Label for failure log messages (e.g., "notification", "badge update")
 * @param preLog - Optional callback for pre-send logging, receives the device list
 * @param includeDevice - Optional filter: only devices it returns true for are sent to
 * @returns true when every device took the push (or there was none to send
 *   to), false when at least one send failed for a reason other than a stale token
 */
async function sendToAllDevices(
  userId: number,
  buildNotification: (device: ApnsDeviceRow) => Notification | SilentNotification,
  logLabel: string,
  preLog?: (devices: ApnsDeviceRow[]) => void,
  includeDevice?: (device: ApnsDeviceRow) => boolean,
): Promise<boolean> {
  if (!isApnsConfigured()) return true

  const db = getDb()
  const devices = (
    db
      .prepare(
        'SELECT id, device_token, bundle_id, environment FROM apns_devices WHERE user_id = ?',
      )
      .all(userId) as ApnsDeviceRow[]
  ).filter((device) => !includeDevice || includeDevice(device))

  if (devices.length === 0) return true

  if (preLog) preLog(devices)

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const notification = buildNotification(device)

      try {
        const env = await sendTryingBothEnvironments(device.environment, notification)
        if (env !== device.environment) {
          db.prepare('UPDATE apns_devices SET environment = ? WHERE id = ?').run(env, device.id)
          log.info('apns', `Device token ${device.id} is ${env}, not ${device.environment} — fixed`)
        }
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
  return failures.length === 0
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

  const delivered = await sendToAllDevices(
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

  // The alert carried `aps.badge`, so it set the badge too. The overdue
  // checker's change gate (badge-state.ts) has to know, or it re-sends the
  // same number as a badge-only push a minute later.
  if (payload.badge !== undefined) {
    if (delivered) recordBadgeSent(userId, payload.badge)
    else forgetBadgeSent(userId)
  }
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
 * - `reminder_count` — pending ITEMS at send time: reminders plus waiting quota
 *   prompts (header fallback only — "N waiting" while the checklist loads, and
 *   the checklist lists both kinds, so the total is the number it will show).
 *   The name predates quota prompts and is kept so shipped builds read it.
 * - `prompt_count` — how many of those are quota prompts (informational)
 *
 * `collapseId` is per-slot, so a later push for the same slot REPLACES the
 * earlier one rather than stacking: the slot's banner always shows the current
 * count (§4.2 class-level collapse).
 */
export interface ApnsSlotReminderPayload {
  slotId: number
  slotLabel: string
  /** Reminders waiting in the slot. */
  count: number
  /**
   * Quota prompts waiting in the slot (quota reminders, 2026-09-24). A prompt
   * counts exactly like a reminder: it is in the checklist, and it keeps the
   * slot unfinished until it is considered or done. 0 when the user or the
   * server has prompts switched off. Defaults to 0.
   */
  promptCount?: number
  /**
   * Alert body override. Defaults to `slotWaitingBody(count, promptCount)`.
   *
   * The hourly nag (`slot-nags.ts`) sends through this same function so it
   * inherits the category, the checklist and the action buttons, but its body
   * has to say more — it speaks for the other unfinished slots too.
   */
  body?: string
}

/**
 * What a slot says is waiting: "3 reminders waiting", "2 quotas waiting", or
 * both, "3 reminders · 2 quotas waiting". One phrase for the slot-open push
 * and the hourly nag (`slotNagBody` builds on it), so the two never word the
 * same slot differently. A zero side is left out rather than said — "0 quotas"
 * is chrome for something that isn't there. The prompt side says "quotas":
 * a period shows at most one prompt per quota, so the two counts agree.
 */
export function slotWaitingBody(reminders: number, prompts = 0): string {
  const parts: string[] = []
  if (reminders > 0 || prompts <= 0) {
    parts.push(reminders === 1 ? '1 reminder' : `${reminders} reminders`)
  }
  if (prompts > 0) parts.push(prompts === 1 ? '1 quota' : `${prompts} quotas`)
  return `${parts.join(' · ')} waiting`
}

export async function sendApnsSlotReminder(
  userId: number,
  payload: ApnsSlotReminderPayload,
): Promise<void> {
  const prompts = payload.promptCount ?? 0
  const body = payload.body ?? slotWaitingBody(payload.count, prompts)

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
          reminder_count: payload.count + prompts,
          prompt_count: prompts,
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
        `Sending slot reminder "${payload.slotLabel}" (${payload.count} reminders, ${prompts} prompts) to ${devices.length} device(s)`,
      )
    },
  )
}

export interface ApnsEnrichedPayload {
  title: string
  body: string
  taskId: number
}

/** Must match `NotificationCategory.taskAdded` in `ios/Shared/NotificationIdentifiers.swift`. */
export const TASK_ADDED_CATEGORY = 'TASK_ADDED'

/**
 * The "AI finished" notification for a just-added task (enrichment-notify.ts).
 *
 * A banner without sound: `interruption-level: active` (shows as a banner
 * and lights the screen, but respects Focus), no `sound` key, APNs priority
 * 10 so it arrives at once. It was `passive` (Notification Center only, no
 * banner) until 2026-09-30, when Trent said it should pop up while he's using
 * the phone, just not make a sound.
 * Category `TASK_ADDED` (`TASK_ADDED_CATEGORY`): two buttons, Done and
 * Delete (destructive), registered by every app (`registerNotificationCategories`
 * in `ios/Shared/NotificationConstants.swift` — iPhone, Watch and Mac). Both
 * POST `/api/notifications/actions` (`done` / `delete`) through the shared
 * `NotificationActionRunner`. No snooze: the task was just added, so it isn't
 * overdue and "+1hr" means nothing yet. Not in the content extension's
 * `UNNotificationExtensionCategory` list, so the system's own expanded view
 * shows it. No `badge`: this says nothing about the overdue count, so it
 * leaves the icon alone.
 *
 * `data.taskId` is the key the apps read: a body tap lands in the runner's
 * task branch (`.openTask` → `navigateToTask`, i.e. `/?task=<id>`, which
 * reveals and selects the row — see `DashboardClient.tsx`'s `?task=` effect),
 * and the `dismiss` silent push that a done/snooze/delete sends for the task
 * clears this notification too.
 *
 * `threadId` and `collapseId` are `enriched-<id>`: each task is its own stack,
 * and a second push for the same task would replace, not stack.
 *
 * Sent to every registered device, the watch app included — the same set as
 * overdue alerts (`sendApnsNotification`). Only the badge push skips the watch,
 * and that is because watchOS has no icon badge.
 */
export function buildEnrichedNotification(
  deviceToken: string,
  topic: string,
  payload: ApnsEnrichedPayload,
): Notification {
  const id = `enriched-${payload.taskId}`
  return new Notification(deviceToken, {
    alert: { title: payload.title, body: payload.body },
    topic,
    category: TASK_ADDED_CATEGORY,
    threadId: id,
    collapseId: id,
    priority: Priority.immediate,
    data: { taskId: payload.taskId },
    aps: { 'interruption-level': 'active' },
  })
}

export async function sendApnsEnrichedNotification(
  userId: number,
  payload: ApnsEnrichedPayload,
): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) => buildEnrichedNotification(device.device_token, device.bundle_id, payload),
    'enrichment notifications',
    (devices) => {
      log.info(
        'apns',
        `Sending enrichment notification for task ${payload.taskId} to ${devices.length} device(s)`,
      )
    },
  )
}

/**
 * The "AI couldn't process" notification for a task whose enrichment failed
 * for good (`enrichment-failed-notify.ts`). The same delivery as the "AI
 * finished" one above, on purpose — a banner without sound
 * (`interruption-level: active`, no `sound`, APNs priority 10, no `badge`),
 * category `TASK_ADDED` (Done and Delete, through the shared
 * `NotificationActionRunner`, which keys on `taskId` alone, so the apps need
 * no change), and `data.taskId` for the tap and the `dismiss` silent push.
 *
 * Only the ids differ: `threadId` and `collapseId` are `ai-failed-<id>`, never
 * `enriched-<id>`, so a failure alert never replaces or is replaced by an "AI
 * finished" push for the same task (a re-enrichment can produce both, at
 * different times), and two failure alerts for one task replace each other
 * rather than stack.
 */
export function buildEnrichmentFailedNotification(
  deviceToken: string,
  topic: string,
  payload: ApnsEnrichedPayload,
): Notification {
  const id = `ai-failed-${payload.taskId}`
  return new Notification(deviceToken, {
    alert: { title: payload.title, body: payload.body },
    topic,
    category: TASK_ADDED_CATEGORY,
    threadId: id,
    collapseId: id,
    priority: Priority.immediate,
    data: { taskId: payload.taskId },
    aps: { 'interruption-level': 'active' },
  })
}

export async function sendApnsEnrichmentFailedNotification(
  userId: number,
  payload: ApnsEnrichedPayload,
): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) => buildEnrichmentFailedNotification(device.device_token, device.bundle_id, payload),
    'enrichment-failed notifications',
    (devices) => {
      log.info(
        'apns',
        `Sending enrichment-failed notification for task ${payload.taskId} to ${devices.length} device(s)`,
      )
    },
  )
}

export interface ApnsSweepResultPayload {
  title: string
  body: string
  /** Overdue tasks left after the sweep — the content extension's grid header. */
  totalOverdueCount: number
  /** The highest tier left behind: 4 when any Urgent is, else 3 (High). */
  priority: 3 | 4
}

/** One sweep result at a time: a newer one replaces the older (`collapseId`). */
export const SWEEP_RESULT_COLLAPSE_ID = 'sweep-result'

/**
 * The bulk-snooze feedback notification (sweep-feedback.ts): what a sweep run
 * from a notification button, a widget or a Shortcut left overdue.
 *
 * A banner without sound, exactly like the "AI finished" push above:
 * `interruption-level: active`, no `sound`, APNs priority 10. No `badge`
 * either — the sweep itself already re-synced the badge
 * (`dismissNotificationsForTasks` in bulkSnooze).
 *
 * Category `TASK_SUMMARY`, thread `ot-tasks`: the same buttons ("All +1hr",
 * the period actions) and, on long-press, the same bulk snooze grid as the
 * overdue summary (`sendApnsSummaryNotification`). The content extension reads
 * `totalOverdueCount` for the grid's "N overdue tasks" header; `overflowCount`
 * is its fallback and is sent with the same number.
 *
 * `collapseId` `sweep-result`: a second press that still leaves something
 * behind REPLACES this banner instead of stacking a second one.
 *
 * `priority` IS LOAD-BEARING, and not a task's priority. After every sweep
 * the apps clear the delivered banners of the tiers the sweep moved
 * (`dismissNotificationsAfterSweep` → `dismissNotifications(atOrBelowPriority:)`
 * in `ios/Shared/NotificationConstants.swift`), and a banner with no
 * `priority` counts as 0 there. This push is sent while the response to that
 * very sweep is still on its way back, so without a priority it could land
 * first and be cleared by the sweep it reports. With the highest tier it
 * names, the lifecycle follows the tasks:
 * - the sweep that produced it (ceiling 2) leaves it standing;
 * - a later sweep that takes the High tier (ceiling 3) clears a "High still
 *   overdue" banner, at the moment it goes stale;
 * - one naming Urgent (4) is never cleared by a sweep, since Urgent is never
 *   swept: it goes when replaced, when acted on or tapped (the runner removes
 *   a summary's own banner, a body tap clears all), or with `dismiss-all`
 *   when the app is opened.
 * No `taskId`, so the per-task `dismiss` push never matches it.
 */
export function buildSweepResultNotification(
  deviceToken: string,
  topic: string,
  payload: ApnsSweepResultPayload,
): Notification {
  return new Notification(deviceToken, {
    alert: { title: payload.title, body: payload.body },
    topic,
    category: 'TASK_SUMMARY',
    threadId: NOTIFICATION_THREADS.tasks,
    collapseId: SWEEP_RESULT_COLLAPSE_ID,
    priority: Priority.immediate,
    data: {
      kind: SWEEP_RESULT_COLLAPSE_ID,
      totalOverdueCount: payload.totalOverdueCount,
      overflowCount: payload.totalOverdueCount,
      priority: payload.priority,
    },
    aps: { 'interruption-level': 'active' },
  })
}

export async function sendApnsSweepResultNotification(
  userId: number,
  payload: ApnsSweepResultPayload,
): Promise<void> {
  await sendToAllDevices(
    userId,
    (device) => buildSweepResultNotification(device.device_token, device.bundle_id, payload),
    'sweep result notifications',
    (devices) => {
      log.info('apns', `Sending sweep result notification to ${devices.length} device(s)`)
    },
  )
}

/**
 * Whether a registered device shows an app-icon badge. The watch app registers
 * its own APNs token (bundle id `<app>.watchapp`, Apple's naming for a watch
 * app), and watchOS has no app icon badge, so badge pushes skip it. Widget
 * push tokens live in their own table (`widget_push_tokens`) and never get one.
 */
export function deviceShowsBadge(device: { bundle_id: string }): boolean {
  return !/\.watch(kit)?app$/.test(device.bundle_id)
}

/**
 * The badge-only push: `{"aps":{"badge":N}}` and nothing else.
 *
 * WHY AN ALERT-TYPE PUSH, NOT A SILENT ONE (2026-09-29). This used to be a
 * silent push (`content-available: 1`, push type `background`) that the app
 * had to wake up for and apply itself. iOS treats those as best-effort: a few
 * an hour, and none while the app isn't running. The overdue checker sent one
 * every minute to every device, so the push that mattered ("now 0", right
 * after a completion from a widget or the Mac) was the one the phone dropped,
 * and the icon kept saying 2.
 *
 * With push type `alert` (apns2's default for a `Notification`) and only
 * `aps.badge`, iOS sets the badge itself on receipt, and macOS sets the Dock
 * tile's. The app is not woken, and the background budget does not apply. It
 * shows no banner and plays no sound, because there is no `alert` and no
 * `sound` key. An old comment here said iOS ignores `aps.badge` without an
 * alert; it doesn't — a badge-only notification is a documented APNs payload.
 * Priority 10 (apns2's default), so a change reaches the icon right away.
 * Volume is kept down by the overdue checker's change gate (badge-state.ts),
 * not by the priority.
 *
 * `collapseId` keeps at most one pending badge push per device: the latest.
 * No `data`: nothing on the device would read it, because an alert push
 * without `content-available` never reaches the app's
 * `didReceiveRemoteNotification`.
 */
export function buildBadgeNotification(
  deviceToken: string,
  topic: string,
  badge: number,
): Notification {
  return new Notification(deviceToken, { topic, badge, collapseId: 'badge-update' })
}

/**
 * Set the app-icon badge (iOS) and the Dock badge (macOS) on the user's
 * devices. Called after mutations that change the overdue count
 * (`syncBadgeCount` in the dismiss module) and by the overdue checker when a
 * user's count differs from what was last sent.
 *
 * Records the value in badge-state.ts when every device took it, and forgets
 * it when any send failed, so the checker's next tick tries again.
 */
export async function sendApnsBadgeUpdate(userId: number, badge: number): Promise<void> {
  const delivered = await sendToAllDevices(
    userId,
    (device) => buildBadgeNotification(device.device_token, device.bundle_id, badge),
    'badge updates',
    undefined,
    deviceShowsBadge,
  )
  if (delivered) recordBadgeSent(userId, badge)
  else forgetBadgeSent(userId)
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

/**
 * WidgetKit push updates (iOS 26 / macOS 26)
 *
 * A different notification shape from everything above: no alert, no badge,
 * no category — just `{ aps: { "content-changed": true } }`, sent with
 * `apns-push-type: widgets` to `<app bundle id>.push-type.widgets` (NOT the
 * app's own topic, which is what `device.bundle_id`/`row.bundle_id` means
 * everywhere else in this file). Tells WidgetKit to reload the widget
 * extension's timelines on that device, same effect as `reloadAllTimelines()`
 * but triggered from the server the moment data changes elsewhere. See
 * https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications
 * and docs/NOTIFICATIONS.md. The coalescer that decides WHEN to call
 * `sendApnsWidgetReload` lives in `@/core/notifications/widget-push`.
 *
 * apns2@12.2.0's `PushType` union predates this iOS 26/macOS 26 push type, so
 * the header value needs a cast below — the request itself is exactly what
 * Apple's docs specify (topic suffix, `content-changed` flag); only the
 * client library's type doesn't know the string "widgets" yet.
 */
class WidgetPushNotification extends Notification {
  constructor(deviceToken: string, topic: string) {
    super(deviceToken, { aps: { 'content-changed': true }, topic })
  }
  override get pushType(): PushType {
    return 'widgets' as unknown as PushType
  }
}

interface WidgetPushTokenRow {
  id: number
  user_id: number
  push_token: string
  bundle_id: string
  platform: string
  environment: string
}

/**
 * Send a WidgetKit "reload your timelines" push to ONE registered widget push
 * token. Per token, not per user, because each device's widget extension has
 * its own push budget and `@/core/notifications/widget-push` (the only caller)
 * paces each token separately. That module also owns the demo-user guard.
 *
 * The row is re-read here, at send time, rather than handed in by the caller:
 * a coalesced push can fire minutes after it was scheduled, and the token may
 * have been rotated or unregistered in between. A missing row is a no-op.
 *
 * Each call logs one "Sending widget reload push" line naming the token and
 * its platform, so `grep 'widget reload push' | grep -c '(ios)'` counts what
 * the iPhone's budget was charged.
 *
 * Resolves `false` only for a send that failed and could succeed on a later
 * try (network, APNs 5xx, a rejected auth key). The pacing in widget-push.ts
 * then doesn't count it against the token's minimum interval. Everything else
 * resolves `true`, meaning "nothing more to do": sent, APNs not configured,
 * the token row gone, or a stale token just removed.
 */
export async function sendApnsWidgetReload(tokenId: number): Promise<boolean> {
  if (!isApnsConfigured()) return true

  const db = getDb()
  const row = db
    .prepare(
      'SELECT id, user_id, push_token, bundle_id, platform, environment FROM widget_push_tokens WHERE id = ?',
    )
    .get(tokenId) as WidgetPushTokenRow | undefined

  if (!row) return true

  log.info(
    'apns',
    `Sending widget reload push to token ${row.id} (${row.platform}) for user ${row.user_id}`,
  )

  const topic = `${row.bundle_id}.push-type.widgets`
  const notification = new WidgetPushNotification(row.push_token, topic)
  try {
    const env = await sendTryingBothEnvironments(row.environment, notification)
    if (env !== row.environment) {
      db.prepare('UPDATE widget_push_tokens SET environment = ? WHERE id = ?').run(env, row.id)
      log.info('apns', `Widget push token ${row.id} is ${env}, not ${row.environment} — fixed`)
    }
    return true
  } catch (err: unknown) {
    if (isStaleTokenError(err)) {
      db.prepare('DELETE FROM widget_push_tokens WHERE id = ?').run(row.id)
      log.info('apns', `Removed stale widget push token ${row.id}`)
      return true
    }
    const reason = (err as ApnsError)?.reason ?? err
    log.error('apns', `Failed to send widget reload push to token ${row.id}: ${reason}`)
    return false
  }
}
