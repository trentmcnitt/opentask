/**
 * Shared notification dismiss helper
 *
 * Sends dismiss signals to all notification channels (Web Push + APNs).
 * Fire-and-forget — errors are logged but never thrown to callers.
 */

import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { dismissApnsNotifications } from '@/core/notifications/apns'
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
