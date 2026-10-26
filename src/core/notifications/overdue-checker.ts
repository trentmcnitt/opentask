/**
 * Unified overdue task notification checker — runs every minute
 *
 * Checks for overdue tasks across ALL priorities and produces their pushes
 * (Web Push and APNs) for the minute's tick (tick.ts), which picks the one
 * that alerts per user and sends the rest passive.
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
 * TIMING IS STATELESS — no mutable state, no DB writes — and since 2026-10-26
 * every REPEAT lands on a clock mark (nag-marks.ts; Trent: "every repeat on a
 * clock mark, overdue included"):
 *  - the FIRST push is exact: the first tick at or after the due time (a
 *    target deferred to 10:07 fires at 10:07);
 *  - the first repeat is `nextNagAt(first push, I)`: the local mark nearest
 *    first + I, a tie to the earlier (grid 60 for I ≥ 60, else the largest
 *    divisor of 60 ≤ I);
 *  - every later repeat is a fixed S on (I rounded to the grid), so the whole
 *    sequence is a function of the due time alone (`isRepeatMinute`). A P3 due
 *    at 8:07 at I = 15 notifies 8:07, 8:15, 8:30, 8:45 … (until 2026-10-26:
 *    8:07, 8:22, 8:37).
 *
 * Repeat intervals are user settings (per-task override takes precedence):
 * - P4 (Urgent): user.auto_snooze_urgent_minutes (default 5 min)
 * - P3 (High): user.auto_snooze_high_minutes (default 15 min)
 * - P0-P2: user.auto_snooze_minutes (default 30 min)
 */

import { OVERDUE_WORD, OVERDUE_LOWER } from '@/lib/task-model-words'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'
import { sendPushNotification } from '@/core/notifications/web-push'
import {
  sendApnsNotification,
  sendApnsSummaryNotification,
  sendApnsBadgeUpdate,
} from '@/core/notifications/apns'
import { getOverdueCount } from '@/core/notifications/dismiss'
import { lastBadgeSent, usersWithNonZeroBadge } from '@/core/notifications/badge-state'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import {
  APP_URL,
  OVERDUE_SUMMARY_COLLAPSE_ID,
  interruptionLevelFor,
  notificationTitlePrefix,
  taskCollapseId,
} from '@/core/notifications/format'
import { nagIntervalMinutes } from '@/core/notifications/nag-ladder'
import { isRepeatMinute, minuteIndex } from '@/core/notifications/nag-marks'
import { notifiableUserSql } from '@/core/notifications/notifiable-users'
import { mergeSettled, type DeliveryResult } from '@/core/notifications/delivery-result'
import {
  runTick,
  type Channels,
  type Delivery,
  type PushKind,
  type SourcePlan,
  type TickSend,
  type TickSource,
} from '@/core/notifications/tick'

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
  /** Anchors a floating rule's grid (every N, or bare) when there is no due_at (`todaysOccurrence`). */
  occurrence_at?: string | null
  /** On deck (2026-10-20): never notified (the SQL leaves decks out; `effectiveDueAt` agrees). */
  on_deck_day?: string | null
  /** A deadline-anchored repeat is never given today's occurrence as a target (`effectiveDueAt`). */
  repeat_anchor?: 'target' | 'deadline' | null
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
  /** Where the overflow summary ranks in the tick's lead order (tick.ts). */
  summaryKind: PushKind
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
  // The tier rung comes from the one ladder (nag-ladder.ts, ruling 1) — the
  // overdue row is the user's tiers as set.
  const tiers = {
    unset: task.user_auto_snooze_minutes,
    low: task.user_auto_snooze_low_minutes,
    medium: task.user_auto_snooze_medium_minutes,
    high: task.user_auto_snooze_high_minutes,
    urgent: task.user_auto_snooze_urgent_minutes,
  }
  return nagIntervalMinutes('overdue', task.priority, tiers)
}

/**
 * Whether this cron minute notifies the task: its FIRST push (the first tick
 * at or after the due time — the query takes `due_at <= now`, so a task due
 * at 9:00:00 is seen by the 9:00 tick and one due at 9:00:30 by the 9:01
 * tick), or a REPEAT on the clock-mark grid derived from that first push
 * (`isRepeatMinute`, nag-marks.ts). The first push goes once: there used to
 * be a second "fire at minute 1" rule from when the query was strict <; with
 * <= it sent every overdue notification twice, at the due minute and one
 * minute later (Trent, 09-29: "notifications at 9:01 ... I don't know where
 * those are coming from"). Don't add it back.
 */
export function isNotificationBoundary(task: OverdueTask, now: Date): boolean {
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const dueMs = new Date(task.effective_due_at).getTime()
  if (now.getTime() < dueMs) return false
  const firstPush = Math.ceil(dueMs / 60_000)
  if (minuteIndex(now) === firstPush) return true
  return isRepeatMinute(firstPush, interval, now, task.timezone)
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
      label: `tasks ${OVERDUE_LOWER}`,
      summaryKind: 'overdue_other',
    },
    high: {
      individual: high.slice(0, HIGH_CAP),
      overflow: Math.max(0, high.length - HIGH_CAP),
      label: `high priority tasks ${OVERDUE_LOWER}`,
      summaryKind: 'overdue_high',
    },
    urgent: {
      individual: urgent,
      overflow: 0,
      label: '',
      summaryKind: 'overdue_urgent',
    },
  }
}

/** The tick's kind for an overdue banner (its place in the lead order, tick.ts). */
function overdueKind(priority: number): PushKind {
  if (priority >= URGENT_PRIORITY) return 'overdue_urgent'
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'overdue_high'
  return priority === 2 ? 'overdue_medium' : 'overdue_other'
}

/** Send an individual Web Push notification for a single task. */
async function sendIndividualWebPush(
  task: OverdueTask,
  delivery: Delivery,
): Promise<DeliveryResult> {
  return sendPushNotification(task.user_id, {
    title: `${notificationTitlePrefix(task.priority)}${task.title}`,
    body: `${OVERDUE_WORD} task${delivery.suffix ?? ''}`,
    data: { url: `${APP_URL}/?task=${task.id}`, taskId: task.id },
    // The APNs collapse id (fix #6): a repeat REPLACES this task's banner,
    // and `renotify` makes the replacement alert again — without it a tagged
    // repeat would land silently and the nag would stop nagging on the web.
    // A passive one (another push leads the tick) is silent instead.
    tag: taskCollapseId(task.id),
    ...(delivery.passive ? { silent: true } : { renotify: true }),
  })
}

/** Send a summary Web Push notification for bucket overflow. */
async function sendSummaryWebPush(
  userId: number,
  count: number,
  label: string,
  delivery: Delivery,
): Promise<DeliveryResult> {
  return sendPushNotification(userId, {
    title: `${count} more ${label}`,
    body: `Open app to see all ${OVERDUE_LOWER} tasks${delivery.suffix ?? ''}`,
    data: { url: `${APP_URL}/?filter=overdue` },
    tag: OVERDUE_SUMMARY_COLLAPSE_ID,
    ...(delivery.passive ? { silent: true } : { renotify: true }),
  })
}

/** Send an individual APNs notification for a task with full payload for the snooze grid. */
async function sendIndividualApns(
  task: OverdueTask,
  overdueCount: number,
  badgeCount: number,
  delivery: Delivery,
): Promise<DeliveryResult> {
  return sendApnsNotification(task.user_id, {
    title: `${notificationTitlePrefix(task.priority)}${task.title}`,
    body: `${OVERDUE_WORD} task${delivery.suffix ?? ''}`,
    taskId: task.id,
    // The occurrence being notified about, not the stored due_at (§4.6) — for
    // a recurring task those differ, and the client would otherwise show a
    // months-old date on a notification about today.
    dueAt: task.effective_due_at,
    priority: task.priority,
    overdueCount,
    badge: badgeCount,
    interruptionLevel: delivery.passive ? 'passive' : interruptionLevelFor(task.priority),
    criticalAlertVolume: task.priority >= URGENT_PRIORITY ? task.critical_alert_volume : undefined,
  })
}

interface UserCounts {
  /** For the iOS "All" button — bulk-snoozable tasks this tick (P0-P2). */
  overdueCount: number
  /** The badge: every overdue task of the user, notified this tick or not. */
  badgeCount: number
}

/** One bucket's pushes as tick sends: each individual task, then the overflow summary. */
function bucketSends(
  bucket: NotificationBucket,
  userId: number,
  counts: UserCounts,
  channels: Channels,
): TickSend[] {
  const sends: TickSend[] = bucket.individual.map((task) => ({
    userId,
    kind: overdueKind(task.priority),
    items: 1,
    // Urgent overdue is critical, lead or not (Trent, 2026-10-26).
    alwaysAlerts: task.priority >= URGENT_PRIORITY,
    deliver: async (delivery) => {
      const sends: Promise<DeliveryResult>[] = []
      if (channels.webPush) sends.push(sendIndividualWebPush(task, delivery))
      if (channels.apns) {
        sends.push(sendIndividualApns(task, counts.overdueCount, counts.badgeCount, delivery))
      }
      return mergeSettled(await Promise.allSettled(sends))
    },
  }))

  if (bucket.overflow > 0) {
    sends.push({
      userId,
      // High's summary ranks with High overdue, the regular one with other overdue.
      kind: bucket.summaryKind,
      items: bucket.overflow,
      deliver: async (delivery) => {
        const sends: Promise<DeliveryResult>[] = []
        if (channels.webPush) {
          sends.push(sendSummaryWebPush(userId, bucket.overflow, bucket.label, delivery))
        }
        if (channels.apns) {
          sends.push(
            sendApnsSummaryNotification(
              userId,
              `${bucket.overflow} more ${bucket.label}`,
              `Open app to see all ${OVERDUE_LOWER} tasks${delivery.suffix ?? ''}`,
              bucket.overflow,
              counts.overdueCount,
              { passive: delivery.passive },
            ),
          )
        }
        return mergeSettled(await Promise.allSettled(sends))
      },
    })
  }
  return sends
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
 *   visible notification (it carried `aps.badge`, and recorded it — a passive
 *   one too);
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

/**
 * Every task overdue at `now`, with the time it is being notified about
 * (`effective_due_at`), highest priority first, then most overdue.
 *
 * Fetches CANDIDATES, then decides due-ness in JS (§4.6). For anything with a
 * due_at, `due_at <= now` is the answer — a recurring task carries debt
 * exactly like a one-off (Trent, 2026-09-07: "it's been overdue ever since I
 * didn't get it done"). The JS pass exists for the recurring rows WITHOUT a
 * due_at, whose only due time is today's occurrence from the rrule; those are
 * admitted here regardless of due_at and resolved by effectiveDueAt() below.
 * One-offs keep the cheap SQL predicate. Uses a parameterized timestamp (not
 * datetime('now')) so the SQL filter and JS checks share one clock.
 */
function overdueTasksAt(now: Date): OverdueTask[] {
  const candidates = getDb()
    .prepare(
      `
      SELECT t.id, t.title, t.due_at, t.priority, t.user_id,
             t.auto_snooze_minutes,
             t.rrule, t.recurrence_mode, t.anchor_time, t.occurrence_at, t.on_deck_day,
             t.repeat_anchor, u.timezone,
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
        AND ${notifiableUserSql('u')}
        -- §5: tracked items are exempt from the cadence loop (see
        -- currently-due.ts for the rationale).
        AND t.progress_target <= 1
        AND t.is_tracked = 0
        -- §6: reminders are never overdue — their period notifies (Medium+
        -- ones by name, reminder-nags.ts), never this checker.
        AND t.is_reminder = 0
        -- On deck (2026-10-20): a target-less deck never nags (see currently-due.ts).
        AND (t.on_deck_day IS NULL OR t.due_at IS NOT NULL)
        AND (
          t.rrule IS NOT NULL
          OR (t.due_at IS NOT NULL AND datetime(t.due_at) <= datetime(?))
        )
      ORDER BY t.priority DESC, t.due_at ASC
    `,
    )
    .all(now.toISOString()) as OverdueTask[]

  // A deadline's target is stored (§8, 2026-10-12: `target_auto`), so
  // `due_at` is the target for every row — no read-time swap. Priority,
  // then due order (the SQL already orders them; kept explicit for nulls).
  const targeted = [...candidates].sort(
    (a, b) => b.priority - a.priority || (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿'),
  )
  // Each owner's day boundary, read once per owner: the no-target fallback's
  // "today" is their OpenTask day.
  const dayStarts = new Map<number, string>()
  const dayStartOf = (userId: number) => {
    if (!dayStarts.has(userId)) dayStarts.set(userId, dayBoundaryForUser(userId))
    return dayStarts.get(userId)!
  }
  return targeted.flatMap((task) => {
    const effective = effectiveDueAt(task, task.timezone, dayStartOf(task.user_id), now)
    if (!effective || effective.getTime() > now.getTime()) return []
    return [{ ...task, effective_due_at: effective.toISOString() }]
  })
}

/**
 * This minute's overdue pushes, as tick sends (read-only), and the badge-only
 * pushes as the after-step. Nothing to send with both channels off.
 */
export function planOverdueSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.webPush && !channels.apns) return { sends: [] }
  const overdueTasks = overdueTasksAt(now)

  // Each user's overdue count, from the rows already in hand. Same
  // population as `getOverdueCount` (both exclude done, deleted, archived,
  // quotas and reminders, and use `effectiveDueAt`) without walking every
  // recurring task's rrule a second time per user per minute.
  const overdueCounts = new Map<number, number>()
  for (const t of overdueTasks) {
    overdueCounts.set(t.user_id, (overdueCounts.get(t.user_id) ?? 0) + 1)
  }

  // Group the tasks on a notification minute by user for visible notifications.
  const tasksByUser = new Map<number, OverdueTask[]>()
  for (const task of overdueTasks.filter((t) => isNotificationBoundary(t, now))) {
    const list = tasksByUser.get(task.user_id) || []
    list.push(task)
    tasksByUser.set(task.user_id, list)
  }

  const sends: TickSend[] = []
  for (const [userId, tasks] of tasksByUser) {
    const { regular, high, urgent } = splitIntoBuckets(tasks)
    const counts: UserCounts = {
      overdueCount: tasks.filter((t) => t.priority < HIGH_PRIORITY_THRESHOLD).length,
      badgeCount: overdueCounts.get(userId) ?? 0,
    }
    for (const bucket of [regular, high, urgent]) {
      sends.push(...bucketSends(bucket, userId, counts, channels))
    }
  }

  return {
    sends,
    after: channels.apns ? () => sendChangedBadges(overdueCounts, tasksByUser) : undefined,
  }
}

/** The overdue checker as one of the minute tick's sources (tick.ts). */
export const OVERDUE_SOURCE: TickSource = {
  name: 'Overdue checker',
  minuteKey: 'tick-overdue',
  plan: planOverdueSends,
}

/**
 * The overdue checker on its own (tests): one tick with
 * this source alone. The minute cron runs every source together
 * (`runMinuteTick`, minute-tick.ts).
 */
export async function checkOverdueTasks(nowOverride?: Date): Promise<void> {
  await runTick([OVERDUE_SOURCE], nowOverride ?? new Date())
}
