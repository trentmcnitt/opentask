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
 * Timing uses mod-based boundary detection instead of tracking per-task state.
 * Each task's notification interval is deterministic from its due_at:
 *   floor((now - due_at) / 60000) % interval === 0
 * This means no DB writes are needed — if the cron fires at a boundary minute,
 * the task gets notified. No catch-up bursts after downtime, no mutable columns.
 *
 * Repeat intervals by priority:
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

/** Check whether this cron cycle is a notification boundary for the task. */
export function isNotificationBoundary(task: OverdueTask, now: Date): boolean {
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const minutesSinceDue = Math.floor((now.getTime() - new Date(task.due_at).getTime()) / 60000)
  return minutesSinceDue >= 0 && minutesSinceDue % interval === 0
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

    // Fetch all overdue tasks. Boundary filtering is done in JS because the
    // repeat interval varies by task priority (urgent=5m, high=15m, default=30m).
    // P4 tasks get Web Push here but APNs exclusively from checkCriticalTasks().
    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id,
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

    // Filter to tasks whose due_at aligns with a notification boundary this minute
    const eligibleTasks = overdueTasks.filter((t) => isNotificationBoundary(t, now))
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

      // APNs: individual per task, but skip P4 — those get APNs exclusively
      // from checkCriticalTasks() with time-sensitive interruption level
      if (apnsEnabled) {
        const apnsTasks = [...individualTasks, ...bulkCandidates].filter((t) => t.priority < 4)
        for (const task of apnsTasks) {
          await sendIndividualApns(task, overdueCount)
        }
      }
    }
  } catch (err) {
    log.error('notifications', 'Overdue checker error:', err)
  }
}
