/**
 * Overdue task checker - runs every minute
 *
 * Checks for overdue tasks and sends notifications via Web Push and APNs.
 *
 * Notification strategy by priority:
 * - P2+ (Medium/High/Urgent): Individual notification per task
 * - P0-P1 (Unset/Low), single task: Individual notification (same as P2+)
 * - P0-P1 (Unset/Low), multiple tasks: Bulk summary linking to dashboard filtered by overdue
 *
 * APNs always sends individual notifications (no bulk summary) — each task
 * gets its own snooze grid in the iOS notification content extension.
 *
 * Auto-snooze (notification repeat interval) by priority:
 * - P4 (Urgent): user.auto_snooze_urgent_minutes (default 5 min)
 * - P3 (High): user.auto_snooze_high_minutes (default 15 min)
 * - P0-P2: user.auto_snooze_minutes (default 30 min)
 * - Per-task auto_snooze_minutes override takes precedence over all tiers
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { MEDIUM_PRIORITY_THRESHOLD, HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'

const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

interface OverdueTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
  last_notified_at: string | null
  auto_snooze_minutes: number | null
  user_auto_snooze_minutes: number
  user_auto_snooze_urgent_minutes: number
  user_auto_snooze_high_minutes: number
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

/** Check whether a task's cooldown has elapsed and it's eligible for notification. */
function isEligibleForNotification(task: OverdueTask, now: Date): boolean {
  if (!task.last_notified_at) return true
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const lastNotified = new Date(task.last_notified_at)
  const cooldownMs = interval * 60 * 1000
  return now.getTime() - lastNotified.getTime() >= cooldownMs
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

/** Send a bulk summary Web Push notification for multiple low-priority tasks. */
async function sendBulkWebPush(tasks: OverdueTask[], userId: number): Promise<void> {
  const maxDisplay = 5
  let message = ''
  tasks.slice(0, maxDisplay).forEach((t) => {
    message += `- ${t.title}\n`
  })
  if (tasks.length > maxDisplay) {
    message += `... and ${tasks.length - maxDisplay} more`
  }

  await sendPushNotification(userId, {
    title: `${tasks.length} overdue tasks`,
    body: message.trim(),
    data: { url: `${APP_URL}/?filter=overdue` },
  })
}

/** Send an individual APNs notification for a task with full payload for the snooze grid. */
async function sendIndividualApns(task: OverdueTask, overdueCount: number): Promise<void> {
  const priorityLabel =
    task.priority >= 4 ? 'URGENT: ' : task.priority >= HIGH_PRIORITY_THRESHOLD ? 'HIGH: ' : ''

  await sendApnsNotification(task.user_id, {
    title: `${priorityLabel}${task.title}`,
    body: 'Overdue task',
    taskId: task.id,
    dueAt: task.due_at,
    priority: task.priority,
    overdueCount,
    interruptionLevel: task.priority >= HIGH_PRIORITY_THRESHOLD ? 'time-sensitive' : 'active',
  })
}

export async function checkOverdueTasks(): Promise<void> {
  const webPushEnabled = isWebPushConfigured()
  const apnsEnabled = isApnsConfigured()
  if (!webPushEnabled && !apnsEnabled) return

  try {
    const db = getDb()
    const now = new Date()

    // Fetch all overdue tasks. Cooldown filtering is done in JS because the
    // repeat interval varies by task priority (urgent=5m, high=15m, default=30m).
    // P4 tasks get Web Push here AND Pushover from checkCriticalTasks() — the two
    // modules use independent cooldown columns (last_notified_at vs last_critical_alert_at).
    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id, t.last_notified_at,
               t.auto_snooze_minutes,
               u.auto_snooze_minutes as user_auto_snooze_minutes,
               u.auto_snooze_urgent_minutes as user_auto_snooze_urgent_minutes,
               u.auto_snooze_high_minutes as user_auto_snooze_high_minutes
        FROM tasks t
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND datetime(t.due_at) < datetime('now')
          AND u.notifications_enabled = 1
        ORDER BY t.priority DESC, t.due_at ASC
        LIMIT 100
      `,
      )
      .all() as OverdueTask[]

    // Apply priority-aware cooldown filtering
    const eligibleTasks = overdueTasks.filter((t) => isEligibleForNotification(t, now))
    if (eligibleTasks.length === 0) return

    // Group tasks by user
    const tasksByUser = new Map<number, OverdueTask[]>()
    for (const task of eligibleTasks) {
      const list = tasksByUser.get(task.user_id) || []
      list.push(task)
      tasksByUser.set(task.user_id, list)
    }

    // Send notifications per user with priority-based splitting
    for (const [userId, tasks] of tasksByUser) {
      // Split by priority: P2+ get individual notifications, P0-P1 get bulk
      const individualTasks = tasks.filter((t) => t.priority >= MEDIUM_PRIORITY_THRESHOLD)
      const bulkCandidates = tasks.filter((t) => t.priority < MEDIUM_PRIORITY_THRESHOLD)

      if (individualTasks.length > 20) {
        log.warn(
          'notifications',
          `Sending ${individualTasks.length} individual notifications for user ${userId}`,
        )
      }

      // Count overdue P0/P1 tasks for the "All" button badge in iOS notifications
      const overdueCount = bulkCandidates.length

      // Web Push: P2+ individual, P0-P1 bulk (or individual if only one)
      if (webPushEnabled) {
        for (const task of individualTasks) {
          await sendIndividualWebPush(task)
        }
        if (bulkCandidates.length === 1) {
          await sendIndividualWebPush(bulkCandidates[0])
        } else if (bulkCandidates.length > 1) {
          await sendBulkWebPush(bulkCandidates, userId)
        }
      }

      // APNs: always individual — each task gets its own snooze grid
      if (apnsEnabled) {
        for (const task of [...individualTasks, ...bulkCandidates]) {
          await sendIndividualApns(task, overdueCount)
        }
      }

      // Update last_notified_at for all notified tasks
      const allNotified = [...individualTasks, ...bulkCandidates]
      const taskIds = allNotified.map((t) => t.id)
      const placeholders = taskIds.map(() => '?').join(',')
      db.prepare(`UPDATE tasks SET last_notified_at = ? WHERE id IN (${placeholders})`).run(
        now.toISOString(),
        ...taskIds,
      )
    }
  } catch (err) {
    log.error('notifications', 'Overdue checker error:', err)
  }
}
