/**
 * Unified overdue task notification checker — runs every minute
 *
 * Checks for overdue tasks across ALL priorities and sends notifications
 * via Web Push and APNs.
 *
 * Consolidation prevents notification flooding:
 * - Regular (P0-P2): 4 individual + summary if more
 * - High (P3): 5 individual + summary if more
 * - Urgent (P4): unlimited individual, no summary
 *
 * Within each bucket, highest priority tasks get individual notification slots
 * first, then most overdue within the same priority (ORDER BY priority DESC,
 * due_at ASC).
 *
 * Timing uses mod-based boundary detection — no mutable state or DB writes.
 * Each task's notification interval is deterministic from its due_at:
 *   floor((now - due_at) / 60000) % interval === 0
 *
 * Repeat intervals are user settings (per-task override takes precedence):
 * - P4 (Urgent): user.auto_snooze_urgent_minutes (default 5 min)
 * - P3 (High): user.auto_snooze_high_minutes (default 15 min)
 * - P0-P2: user.auto_snooze_minutes (default 30 min)
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import {
  sendApnsNotification,
  sendApnsSummaryNotification,
  sendApnsBadgeUpdate,
  isApnsConfigured,
} from '@/core/notifications/apns'
import { getOverdueCount } from '@/core/notifications/dismiss'

const APP_URL = process.env.AUTH_URL || 'http://localhost:3000'

/** Consolidation caps per bucket */
const REGULAR_CAP = 4 // P0-P2
const HIGH_CAP = 5 // P3
// P4: unlimited

interface OverdueTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
  auto_snooze_minutes: number | null
  user_auto_snooze_minutes: number
  user_auto_snooze_urgent_minutes: number
  user_auto_snooze_high_minutes: number
  critical_alert_volume: number
}

interface NotificationBucket {
  individual: OverdueTask[]
  overflow: number
  label: string
}

/**
 * Get the effective notification repeat interval for a task in minutes.
 * Per-task override > priority-based user default.
 */
function getEffectiveInterval(task: OverdueTask): number {
  if (task.auto_snooze_minutes !== null) return task.auto_snooze_minutes
  if (task.priority >= 4) return task.user_auto_snooze_urgent_minutes
  if (task.priority >= HIGH_PRIORITY_THRESHOLD) return task.user_auto_snooze_high_minutes
  return task.user_auto_snooze_minutes
}

/** Check whether this cron cycle is a notification boundary for the task. */
export function isNotificationBoundary(task: OverdueTask, now: Date): boolean {
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const minutesSinceDue = Math.floor((now.getTime() - new Date(task.due_at).getTime()) / 60000)
  if (minutesSinceDue < 0) return false
  // First overdue minute: tasks due at exact minute boundaries (the common case
  // from UI pickers) are first seen at minutesSinceDue = 1 because the SQL query
  // uses strict < (datetime(due_at) < datetime('now')). Without this, the first
  // notification wouldn't fire until the next interval boundary (e.g., 30 min).
  if (minutesSinceDue === 1) return true
  return minutesSinceDue % interval === 0
}

/** Split eligible tasks into consolidation buckets. */
function splitIntoBuckets(tasks: OverdueTask[]): {
  regular: NotificationBucket
  high: NotificationBucket
  urgent: NotificationBucket
} {
  // Tasks are already sorted by priority DESC, due_at ASC from the query,
  // so slicing respects the "highest priority first, most overdue second" order.
  const regular = tasks.filter((t) => t.priority < HIGH_PRIORITY_THRESHOLD)
  const high = tasks.filter((t) => t.priority >= HIGH_PRIORITY_THRESHOLD && t.priority < 4)
  const urgent = tasks.filter((t) => t.priority >= 4)

  return {
    regular: {
      individual: regular.slice(0, REGULAR_CAP),
      overflow: Math.max(0, regular.length - REGULAR_CAP),
      label: 'tasks overdue',
    },
    high: {
      individual: high.slice(0, HIGH_CAP),
      overflow: Math.max(0, high.length - HIGH_CAP),
      label: 'high priority tasks overdue',
    },
    urgent: {
      individual: urgent,
      overflow: 0,
      label: '',
    },
  }
}

/** Send an individual Web Push notification for a single task. */
async function sendIndividualWebPush(task: OverdueTask): Promise<void> {
  const priorityLabel =
    task.priority >= 4 ? 'URGENT: ' : task.priority >= HIGH_PRIORITY_THRESHOLD ? 'HIGH: ' : ''

  await sendPushNotification(task.user_id, {
    title: `${priorityLabel}${task.title}`,
    body: 'Overdue task',
    data: { url: `${APP_URL}/?task=${task.id}`, taskId: task.id },
  })
}

/** Send a summary Web Push notification for bucket overflow. */
async function sendSummaryWebPush(userId: number, count: number, label: string): Promise<void> {
  await sendPushNotification(userId, {
    title: `${count} more ${label}`,
    body: 'Open app to see all overdue tasks',
    data: { url: `${APP_URL}/?filter=overdue` },
  })
}

/** Send an individual APNs notification for a task with full payload for the snooze grid. */
async function sendIndividualApns(
  task: OverdueTask,
  overdueCount: number,
  badgeCount: number,
): Promise<void> {
  const priorityLabel =
    task.priority >= 4 ? 'URGENT: ' : task.priority >= HIGH_PRIORITY_THRESHOLD ? 'HIGH: ' : ''

  await sendApnsNotification(task.user_id, {
    title: `${priorityLabel}${task.title}`,
    body: 'Overdue task',
    taskId: task.id,
    dueAt: task.due_at,
    priority: task.priority,
    overdueCount,
    badge: badgeCount,
    // P3+ get time-sensitive (breaks through Focus/scheduled summary).
    // Critical alerts require Apple entitlement approval — use time-sensitive until approved.
    interruptionLevel: task.priority >= HIGH_PRIORITY_THRESHOLD ? 'time-sensitive' : 'active',
  })
}

/** Send all notifications for a single bucket (individual + optional summary). */
async function sendBucket(
  bucket: NotificationBucket,
  userId: number,
  overdueCount: number,
  badgeCount: number,
  webPushEnabled: boolean,
  apnsEnabled: boolean,
): Promise<void> {
  const sends: Promise<void>[] = []

  // Individual notifications
  for (const task of bucket.individual) {
    if (webPushEnabled) sends.push(sendIndividualWebPush(task))
    if (apnsEnabled) sends.push(sendIndividualApns(task, overdueCount, badgeCount))
  }

  // Summary notification for overflow
  if (bucket.overflow > 0) {
    if (webPushEnabled) {
      sends.push(sendSummaryWebPush(userId, bucket.overflow, bucket.label))
    }
    if (apnsEnabled) {
      sends.push(
        sendApnsSummaryNotification(
          userId,
          `${bucket.overflow} more ${bucket.label}`,
          'Open app to see all overdue tasks',
        ),
      )
    }
  }

  await Promise.allSettled(sends)
}

export async function checkOverdueTasks(nowOverride?: Date): Promise<void> {
  const webPushEnabled = isWebPushConfigured()
  const apnsEnabled = isApnsConfigured()
  if (!webPushEnabled && !apnsEnabled) return

  try {
    const db = getDb()
    const now = nowOverride ?? new Date()

    // Fetch all overdue tasks across all priorities. Boundary filtering
    // is done in JS because the repeat interval varies per task/priority.
    // Uses a parameterized timestamp (not datetime('now')) so the SQL filter
    // and JS boundary check use the same clock — important for testability.
    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id,
               t.auto_snooze_minutes,
               u.auto_snooze_minutes as user_auto_snooze_minutes,
               u.auto_snooze_urgent_minutes as user_auto_snooze_urgent_minutes,
               u.auto_snooze_high_minutes as user_auto_snooze_high_minutes,
               u.critical_alert_volume
        FROM tasks t
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND datetime(t.due_at) <= datetime(?)
          AND u.notifications_enabled = 1
        ORDER BY t.priority DESC, t.due_at ASC
      `,
      )
      .all(now.toISOString()) as OverdueTask[]

    // Collect unique user IDs with overdue tasks for badge updates
    const usersWithOverdue = new Set(overdueTasks.map((t) => t.user_id))

    // Filter to tasks whose due_at aligns with a notification boundary this minute
    const eligibleTasks = overdueTasks.filter((t) => isNotificationBoundary(t, now))

    // Group eligible tasks by user for visible notifications
    const tasksByUser = new Map<number, OverdueTask[]>()
    for (const task of eligibleTasks) {
      const list = tasksByUser.get(task.user_id) || []
      list.push(task)
      tasksByUser.set(task.user_id, list)
    }

    // Send visible notifications per user with consolidation
    for (const [userId, tasks] of tasksByUser) {
      const { regular, high, urgent } = splitIntoBuckets(tasks)

      // overdueCount for the iOS "All" button — count of bulk-snoozable tasks (P0-P3, excludes P4)
      const overdueCount = tasks.filter((t) => t.priority < URGENT_PRIORITY).length

      // Badge count: total overdue tasks for this user (all priorities).
      // Uses all overdue tasks, not just those eligible for notification this tick.
      const badgeCount = getOverdueCount(userId)

      await sendBucket(regular, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
      await sendBucket(high, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
      await sendBucket(urgent, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
    }

    // Badge-only update for users who have overdue tasks but didn't get
    // visible notifications this cycle. Keeps the app icon badge current.
    if (apnsEnabled) {
      for (const userId of usersWithOverdue) {
        if (tasksByUser.has(userId)) continue // already got badge via visible notification
        const badgeCount = getOverdueCount(userId)
        log.info('notifications', `Badge-only update for user ${userId}: ${badgeCount} overdue`)
        await sendApnsBadgeUpdate(userId, badgeCount)
      }
    }
  } catch (err) {
    log.error('notifications', 'Overdue checker error:', err)
  }
}
