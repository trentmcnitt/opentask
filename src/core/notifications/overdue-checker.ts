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
import { lastBadgeSent, usersWithNonZeroBadge } from '@/core/notifications/badge-state'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { APP_URL, interruptionLevelFor, notificationTitlePrefix } from '@/core/notifications/format'

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
  user_auto_snooze_low_minutes: number
  user_auto_snooze_medium_minutes: number
  critical_alert_volume: number
  // §4.6 inputs — needed for the no-due_at case (today's occurrence from the
  // schedule) and for from_completion. With a due_at, that IS the due time.
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  timezone: string
  /**
   * The due time this task is actually being notified about, from
   * `effectiveDueAt` (§4.6 as amended 2026-09-07). For anything carrying a
   * due_at — one-off or recurring — this IS due_at: a recurring task missed on
   * its day has been overdue since then and keeps being nagged until done. All
   * interval math uses this; a task three days overdue on a 30-minute cadence
   * still fires only on the minute where minutesSinceDue % 30 === 0, so a
   * large value scrambles nothing (see notification-timing.test.ts).
   */
  effective_due_at: string
}

interface NotificationBucket {
  individual: OverdueTask[]
  overflow: number
  label: string
}

/**
 * Get the effective notification repeat interval for a task in minutes.
 * Per-task override > priority-based user default.
 *
 * §4.1 cadence ladder. Every rung branches EXPLICITLY — previously P0, P1 and
 * P2 all fell through to one shared value, which is why priority behaved as a
 * binary "matters" flag rather than a ladder.
 *
 *   P0 unset  → 30 min   (unchanged; L2 failure-safe — an urgent-but-
 *                         unclassified item must still reach the user)
 *   P1 low    → 240 min  (rare, but never silent)
 *   P2 medium → 60 min   (NOT notify-once: one missed glance would lose it
 *                         permanently, which fails dangerous)
 *   P3 high   → 15 min   (unchanged)
 *   P4 urgent → 5 min    (unchanged)
 *
 * P0 keeps its own column rather than sharing with P1: unset means nobody
 * stated a priority (L1), not "lowest", so the two must be tunable apart.
 */
function getEffectiveInterval(task: OverdueTask): number {
  if (task.auto_snooze_minutes !== null) return task.auto_snooze_minutes
  if (task.priority >= URGENT_PRIORITY) return task.user_auto_snooze_urgent_minutes
  if (task.priority >= HIGH_PRIORITY_THRESHOLD) return task.user_auto_snooze_high_minutes
  if (task.priority === 2) return task.user_auto_snooze_medium_minutes
  if (task.priority === 1) return task.user_auto_snooze_low_minutes
  return task.user_auto_snooze_minutes
}

/** Check whether this cron cycle is a notification boundary for the task. */
export function isNotificationBoundary(task: OverdueTask, now: Date): boolean {
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const minutesSinceDue = Math.floor(
    (now.getTime() - new Date(task.effective_due_at).getTime()) / 60000,
  )
  if (minutesSinceDue < 0) return false
  // The first notification is the tick where minutesSinceDue is 0: the query
  // takes due_at <= now, so a task due at 9:00:00 is seen by the 9:00 tick, and
  // one due at 9:00:30 by the 9:01 tick (still 0 whole minutes). 0 % interval
  // is 0 for every interval, so that tick always fires. There used to be a
  // second "fire at minute 1" rule from when the query was strict <; with <=
  // it sent every overdue notification twice, at the due minute and one
  // minute later (Trent, 09-29: "notifications at 9:01 ... I don't know where
  // those are coming from"). Don't add it back.
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
  await sendPushNotification(task.user_id, {
    title: `${notificationTitlePrefix(task.priority)}${task.title}`,
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
  await sendApnsNotification(task.user_id, {
    title: `${notificationTitlePrefix(task.priority)}${task.title}`,
    body: 'Overdue task',
    taskId: task.id,
    // The occurrence being notified about, not the stored due_at (§4.6) — for
    // a recurring task those differ, and the client would otherwise show a
    // months-old date on a notification about today.
    dueAt: task.effective_due_at,
    priority: task.priority,
    overdueCount,
    badge: badgeCount,
    interruptionLevel: interruptionLevelFor(task.priority),
    criticalAlertVolume: task.priority >= URGENT_PRIORITY ? task.critical_alert_volume : undefined,
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
          bucket.overflow,
          overdueCount,
        ),
      )
    }
  }

  await Promise.allSettled(sends)
}

/**
 * Badge-only pushes, sent ONLY when a user's overdue count differs from the
 * badge their devices were last sent (badge-state.ts).
 *
 * This used to send every minute to every device of every user with anything
 * overdue, changed or not: ~95 badge pushes to 5 devices in 100 minutes on
 * prod one morning (2026-09-29), all saying the same number. Those were
 * silent pushes then, and iOS allows a few an hour, so the spam used up the
 * allowance and the one push that mattered (the drop to 0 after a completion)
 * was dropped. The badge push is an alert-type push now (see
 * `buildBadgeNotification`), and this gate keeps it to one push per change.
 *
 * What changes the count without a user action is time: a task becoming
 * overdue. User actions send their own badge (`syncBadgeCount`), which
 * records the value, so they aren't repeated here.
 *
 * Users are:
 * - everyone with something overdue this tick, except those who just got a
 *   visible notification (it carried `aps.badge`, and recorded it);
 * - anyone whose devices were last told a non-zero number but who has nothing
 *   overdue in this tick's rows, so a stale badge falls back to the truth even
 *   if no user action sent the zero. Their count is measured, not assumed 0:
 *   this tick's rows leave out users with notifications switched off.
 */
async function sendChangedBadges(
  overdueCounts: Map<number, number>,
  notifiedUsers: Map<number, unknown>,
): Promise<void> {
  const counts = new Map(overdueCounts)
  for (const userId of usersWithNonZeroBadge()) {
    if (!counts.has(userId)) counts.set(userId, getOverdueCount(userId))
  }

  for (const [userId, badgeCount] of counts) {
    if (notifiedUsers.has(userId)) continue
    if (lastBadgeSent(userId) === badgeCount) continue
    log.info('notifications', `Badge-only update for user ${userId}: ${badgeCount} overdue`)
    await sendApnsBadgeUpdate(userId, badgeCount)
  }
}

export async function checkOverdueTasks(nowOverride?: Date): Promise<void> {
  const webPushEnabled = isWebPushConfigured()
  const apnsEnabled = isApnsConfigured()
  if (!webPushEnabled && !apnsEnabled) return

  try {
    const db = getDb()
    const now = nowOverride ?? new Date()

    // Fetch CANDIDATES, then decide due-ness in JS (§4.6).
    //
    // For anything with a due_at, `due_at <= now` is the answer — a recurring
    // task carries debt exactly like a one-off (Trent, 2026-09-07: "it's been
    // overdue ever since I didn't get it done"). The JS pass exists for the
    // recurring rows WITHOUT a due_at, whose only due time is today's
    // occurrence from the rrule; those are admitted here regardless of due_at
    // and resolved by effectiveDueAt() below. One-offs keep the cheap SQL
    // predicate.
    //
    // Boundary filtering was already done in JS because the repeat interval
    // varies per task/priority. Uses a parameterized timestamp (not
    // datetime('now')) so the SQL filter and JS checks share one clock.
    const candidates = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id,
               t.auto_snooze_minutes,
               t.rrule, t.recurrence_mode, t.anchor_time,
               u.timezone,
               u.auto_snooze_minutes as user_auto_snooze_minutes,
               u.auto_snooze_urgent_minutes as user_auto_snooze_urgent_minutes,
               u.auto_snooze_high_minutes as user_auto_snooze_high_minutes,
               u.auto_snooze_low_minutes as user_auto_snooze_low_minutes,
               u.auto_snooze_medium_minutes as user_auto_snooze_medium_minutes,
               u.critical_alert_volume
        FROM tasks t
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND u.notifications_enabled = 1
          -- §5: tracked items are exempt from the cadence loop (see
          -- currently-due.ts for the rationale).
          AND t.progress_target <= 1
          AND t.is_tracked = 0
          -- §6: reminders never fire individually — their time slot notifies.
          AND t.is_reminder = 0
          AND (
            t.rrule IS NOT NULL
            OR (t.due_at IS NOT NULL AND datetime(t.due_at) <= datetime(?))
          )
        ORDER BY t.priority DESC, t.due_at ASC
      `,
      )
      .all(now.toISOString()) as OverdueTask[]

    const overdueTasks = candidates.flatMap((task) => {
      const effective = effectiveDueAt(task, task.timezone, now)
      if (!effective || effective.getTime() > now.getTime()) return []
      return [{ ...task, effective_due_at: effective.toISOString() }]
    })

    // Each user's overdue count, from the rows already in hand. Same
    // population as `getOverdueCount` (both exclude done, deleted, archived,
    // quotas and reminders, and use `effectiveDueAt`) without walking every
    // recurring task's rrule a second time per user per minute.
    const overdueCounts = new Map<number, number>()
    for (const t of overdueTasks) {
      overdueCounts.set(t.user_id, (overdueCounts.get(t.user_id) ?? 0) + 1)
    }

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

      // overdueCount for the iOS "All" button — count of bulk-snoozable tasks (P0-P2, excludes P3/P4)
      const overdueCount = tasks.filter((t) => t.priority < HIGH_PRIORITY_THRESHOLD).length

      // Badge count: total overdue tasks for this user (all priorities).
      // Uses all overdue tasks, not just those eligible for notification this tick.
      const badgeCount = overdueCounts.get(userId) ?? 0

      await sendBucket(regular, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
      await sendBucket(high, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
      await sendBucket(urgent, userId, overdueCount, badgeCount, webPushEnabled, apnsEnabled)
    }

    if (apnsEnabled) await sendChangedBadges(overdueCounts, tasksByUser)
  } catch (err) {
    log.error('notifications', 'Overdue checker error:', err)
  }
}
