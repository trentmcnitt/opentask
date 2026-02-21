/**
 * Shared notification dismiss helper
 *
 * Sends dismiss signals to all notification channels (Web Push + APNs).
 * Fire-and-forget — errors are logged but never thrown to callers.
 */

import {
  dismissTaskNotifications,
  dismissAllWebPushNotifications,
} from '@/core/notifications/web-push'
import { dismissApnsNotifications, dismissAllApnsNotifications } from '@/core/notifications/apns'
import { log } from '@/lib/logger'

export function dismissNotificationsForTasks(userId: number, taskIds: number[]): void {
  if (taskIds.length === 0) return
  log.info('notifications', `Dismiss requested for tasks [${taskIds.join(',')}] user ${userId}`)
  dismissTaskNotifications(userId, taskIds)
    .then(() => log.info('notifications', `Web Push dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'Web Push dismiss error:', err))
  dismissApnsNotifications(userId, taskIds)
    .then(() => log.info('notifications', `APNs dismiss sent for tasks [${taskIds.join(',')}]`))
    .catch((err) => log.error('notifications', 'APNs dismiss error:', err))
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
