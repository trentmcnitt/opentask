/**
 * Shared notification dismiss and badge update helpers
 *
 * Sends dismiss signals to all notification channels (Web Push + APNs)
 * and updates the iOS app icon badge to reflect the current overdue count.
 * Fire-and-forget — errors are logged but never thrown to callers.
 *
 * Called from the CORE task mutations, after their transaction commits — not
 * from routes (decision D11, 2026-09-29). When each route made the call
 * itself, the routes drifted: bulk edit never dismissed a moved date, restore
 * never resynced the badge, bulk snooze dismissed tasks it had skipped. In
 * core, every caller (web, native apps, notification actions, review) gets it.
 *
 * - dismissNotificationsForTasks (dismiss + badge): markDone, bulkDone,
 *   updateTask when `due_at` or `done` changed (so snoozeTask too), bulkEdit
 *   for the tasks whose date moved, bulkSnooze for the tasks it moved,
 *   deleteTask, bulkDelete, skipOccurrence; and updateTask / bulkEdit for a
 *   reminder whose named push the edit ended — priority below Medium,
 *   converted, moved to Anytime or off today (`namedPushEndCheck`,
 *   reminder-nags.ts).
 * - dismissPromptNotifications (no badge — a quota is never in it): the
 *   named quota-prompt pushes a mutation ended (`promptPushEndCheck`,
 *   prompt-nags.ts) — consider and did it, a count logged, a quota edit, and
 *   the user-level changes (prompt switch, default period, a period deleted
 *   or retimed, the day start).
 * - syncBadgeCount alone (the overdue count may change, but no delivered
 *   banner is known to be stale): createTask when the task is born overdue,
 *   restoreTask, and undo/redo (`afterUndoRedo`).
 *
 * The one route-level caller left is APNs device registration, which is not a
 * task mutation.
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
import { log } from '@/lib/logger'
import { countCurrentlyDue } from '@/core/tasks/currently-due'

/** Count overdue tasks for a user — shared by badge updates and notification logic. */
export function getOverdueCount(userId: number): number {
  // §4.6: the badge cannot be a pure COUNT(*) any more. A recurring task's
  // due_at freezes once the daily sweep stops, so counting `due_at < now` would
  // inflate the badge with items that aren't actually scheduled today — the
  // number the user glances at would stop meaning anything.
  //
  // Against the Tasks page's Overdue pill (`countTasks`, src/lib/task-counts.ts,
  // which the native apps also read on foreground via GET /api/tasks/counts):
  // same population (open, not deleted/archived, no reminders, no quotas), and
  // the same answer for every task with a due_at. Two edges differ: a
  // recurring task with NO due_at is counted here once today's scheduled time
  // passes (the pill never counts an undated task), and the pill also counts
  // another user's overdue tasks in a shared project. Neither existed on prod
  // on 2026-09-29, when this was checked. The rule is kept because the notifier
  // and the snooze-overdue sweep share it (currently-due.ts).
  return countCurrentlyDue(userId)
}

/**
 * Send a badge update to iOS and macOS with the current overdue count.
 * Fire-and-forget — errors are logged but never thrown.
 * Called by dismissNotificationsForTasks and directly by the mutations listed above.
 *
 * Always sends, even when the number is the same as last time: a user action
 * is exactly when a device's badge is most likely to be wrong (another device
 * made the change). `sendApnsBadgeUpdate` records what was sent, so the
 * overdue checker's change gate doesn't send it again (badge-state.ts).
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
 * Dismiss the banners of these quota prompts (named quota-prompt pushes,
 * prompt-nags.ts) on every device — and only theirs: the `dismiss` push
 * carries `promptKeys`, and a banner with a `prompt_key` closes only when its
 * key is listed, so a daily quota's other period's banner stays (review of
 * #377). `taskIds` (the quotas) go along for every other banner of the quota
 * and for native builds before PR 4b, which match `taskIds` alone. No badge
 * sync: a quota is never in the badge. Fire-and-forget.
 */
export function dismissPromptNotifications(userId: number, promptKeys: string[]): void {
  if (promptKeys.length === 0) return
  const taskIds = [...new Set(promptKeys.map((key) => Number(key.split(':')[1])))].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  )
  log.info(
    'notifications',
    `Dismiss requested for prompts [${promptKeys.join(',')}] user ${userId}`,
  )
  dismissTaskNotifications(userId, taskIds, promptKeys).catch((err) =>
    log.error('notifications', 'Web Push prompt dismiss error:', err),
  )
  dismissApnsNotifications(userId, taskIds, promptKeys).catch((err) =>
    log.error('notifications', 'APNs prompt dismiss error:', err),
  )
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
