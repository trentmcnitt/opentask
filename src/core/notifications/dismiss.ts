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
import { countCurrentlyDue } from '@/core/tasks/currently-due'

/** Count overdue tasks for a user — shared by badge updates and notification logic. */
export function getOverdueCount(userId: number): number {
  // §4.6: the badge cannot be a pure COUNT(*) any more. A recurring task's
  // due_at freezes once the daily sweep stops, so counting `due_at < now` would
  // inflate the badge with items that aren't actually scheduled today — the
  // number the user glances at would stop meaning anything.
  return countCurrentlyDue(userId)
}

/**
 * Send a badge update to iOS with the current overdue count.
 * Fire-and-forget — errors are logged but never thrown.
 * Called by dismissNotificationsForTasks and directly by undo/redo routes.
 */
export function syncBadgeCount(userId: number, knownCount?: number): void {
  if (!isApnsConfigured()) return
  // `knownCount` lets a caller that has ALREADY established the post-change
  // overdue count hand it over instead of paying for another
  // `countCurrentlyDue()` — which evaluates an rrule for every recurring task.
  // Only pass it when the number is exact; everyone else measures.
  const badgeCount = knownCount ?? getOverdueCount(userId)
  log.info('notifications', `Badge update for user ${userId}: ${badgeCount} overdue`)
  sendApnsBadgeUpdate(userId, badgeCount)
    .then(() => log.info('notifications', `Badge update sent for user ${userId}: ${badgeCount}`))
    .catch((err) => log.error('notifications', 'Badge update error:', err))
}

export function dismissNotificationsForTasks(
  userId: number,
  taskIds: number[],
  knownOverdueCount?: number,
): void {
  if (taskIds.length === 0) return
  log.info('notifications', `Dismiss requested for tasks [${taskIds.join(',')}] user ${userId}`)
  dismissTaskNotifications(userId, taskIds)
    .then(() => log.info('notifications', `Web Push dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'Web Push dismiss error:', err))
  dismissApnsNotifications(userId, taskIds)
    .then(() => log.info('notifications', `APNs dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'APNs dismiss error:', err))

  syncBadgeCount(userId, knownOverdueCount)
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
