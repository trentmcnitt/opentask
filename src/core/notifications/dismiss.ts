/**
 * Shared notification dismiss and badge update helpers
 *
 * Sends dismiss signals to all notification channels (Web Push + APNs)
 * and updates the iOS app icon badge to reflect the current overdue count.
 * Fire-and-forget — errors are logged but never thrown to callers.
 *
 * Every mutation that could change the overdue count (snooze, done, delete,
 * edit due_at, bulk ops, notification actions, review) calls
 * dismissNotificationsForTasks, which handles both dismiss and badge update.
 *
 * Mutations that don't dismiss notifications but still change overdue count
 * (undo, redo) call syncBadgeCount directly.
 */

import {
  dismissTaskNotifications,
  dismissAllWebPushNotifications,
} from '@/core/notifications/web-push'
import {
  dismissApnsNotifications,
  dismissAllApnsNotifications,
  sendApnsBadgeUpdate,
  isApnsConfigured,
} from '@/core/notifications/apns'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

/** Count overdue tasks for a user — shared by badge updates and notification logic. */
export function getOverdueCount(userId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
           AND due_at IS NOT NULL AND datetime(due_at) < datetime('now')`,
      )
      .get(userId) as { count: number }
  ).count
}

/**
 * Send a badge update to iOS with the current overdue count.
 * Fire-and-forget — errors are logged but never thrown.
 * Called by dismissNotificationsForTasks and directly by undo/redo routes.
 */
export function syncBadgeCount(userId: number): void {
  if (!isApnsConfigured()) return
  const badgeCount = getOverdueCount(userId)
  log.info('notifications', `Badge update for user ${userId}: ${badgeCount} overdue`)
  sendApnsBadgeUpdate(userId, badgeCount)
    .then(() => log.info('notifications', `Badge update sent for user ${userId}: ${badgeCount}`))
    .catch((err) => log.error('notifications', 'Badge update error:', err))
}

export function dismissNotificationsForTasks(userId: number, taskIds: number[]): void {
  if (taskIds.length === 0) return
  log.info('notifications', `Dismiss requested for tasks [${taskIds.join(',')}] user ${userId}`)
  dismissTaskNotifications(userId, taskIds)
    .then(() => log.info('notifications', `Web Push dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'Web Push dismiss error:', err))
  dismissApnsNotifications(userId, taskIds)
    .then(() => log.info('notifications', `APNs dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'APNs dismiss error:', err))

  syncBadgeCount(userId)
}

/**
 * Dismiss ALL notifications on all devices for a user.
 * Called when the user opens the app on any device — clears notification noise everywhere.
 * Fire-and-forget — errors are logged but never thrown to callers.
 */
export function dismissAllNotifications(userId: number): void {
  log.info('notifications', `Dismiss-all requested for user ${userId}`)
  dismissAllWebPushNotifications(userId)
    .then(() => log.info('notifications', `Web Push dismiss-all sent for user ${userId}`))
    .catch((err) => log.error('notifications', 'Web Push dismiss-all error:', err))
  dismissAllApnsNotifications(userId)
    .then(() => log.info('notifications', `APNs dismiss-all sent for user ${userId}`))
    .catch((err) => log.error('notifications', 'APNs dismiss-all error:', err))
}
