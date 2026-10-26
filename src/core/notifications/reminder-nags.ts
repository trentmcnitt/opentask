/**
 * NAMED REMINDER PUSHES (2026-10-26, Trent; plan "named pushes and marks"
 * Part A; docs/NOTIFICATIONS.md § Named reminder pushes).
 *
 * WHAT. A reminder at Medium or above gets a push of its OWN — its title as
 * the banner's title, "Morning · High reminder" as the body — instead of
 * being one of its period's count. None and Low reminders stay in the period
 * push and the period nag (slot-reminders.ts, slot-nags.ts); Medium+ ones are
 * left out of both (`waitingBySlot`), so a period with only Medium+ waiting
 * sends no period push and no period nag.
 *
 * WHEN A REMINDER GETS ONE — all of:
 *  - it is waiting in today's roster (`getRemindersBySlot`, the Reminders
 *    screen's own: scheduled today, not yet considered);
 *  - its priority is Medium (2) or above (reminder-nag-rule.ts);
 *  - it is in a real period, not Anytime (the un-slotted group never opens);
 *  - its period has opened today (`periodOpensAt` within the OpenTask day);
 *  - its own Nag is not OFF (`auto_snooze_minutes` is not 0).
 *
 * WHEN IT FIRES.
 *  - FIRST at the period's open, exact (the first tick at or after it).
 *  - REPEATS at the slot nag's rung for its priority
 *    (`nagIntervalMinutes('slot_nag', priority)`: the user's tier ×2 —
 *    Medium 120, High 30, Urgent 10 with the shipped tiers), on clock marks
 *    (`nextNagAt`, nag-marks.ts).
 *  - STOPS when considered (it leaves the roster) and at the end of the
 *    OpenTask day (the next day's periods have not opened). No extra state.
 *
 * PACING: `nag_sends`, one row per reminder, key `reminder-<taskId>`, with no
 * date. Due when `last === null || last < periodOpenedAt || now >=
 * nextNagAt(last, I)` — the `since` floor of `claimNagSend` is the period's
 * open, so each day starts afresh whatever the rung. The claim is the
 * compare-and-swap the other nags use, under the tick's per-minute claim
 * (`tick-reminder-nags`). The weekly purge drops the rows of reminders that
 * are gone (`purgeGoneReminderNags`).
 *
 * HOW (one alert per tick, tick.ts). Kinds `reminder_urgent`,
 * `reminder_high`, `reminder_medium`, in their places in `LEAD_ORDER`. High
 * and Urgent SOUND (APNs `sound: default`, Web Push `renotify`); Medium is
 * SILENT by its own rule (`silent`), so it never leads a minute in which
 * something sounds. Every banner is `interruption-level: active` — never
 * time-sensitive, never critical: evening ones sound until the day start and
 * the phone's Sleep Focus silences them (Trent, ruling 8). Payloads:
 * `buildReminderNagNotification` (apns.ts) and `sendReminderWebPush` below,
 * with a "Considered" button on the web (public/sw.js → POST
 * /api/notifications/actions with `day`).
 *
 * WHY THIS IS NOT A §6 VIOLATION. REDESIGN-V03 §6 says the slot notifies, not
 * the item; Trent ruled the exception on 2026-10-26 for Medium and above. A
 * reminder still carries no debt: never overdue, never in the badge, and
 * nothing rolls forward past the day.
 *
 * DESIGN: a read-only decision (`pendingReminderNags`) and the tick source
 * (`planReminderNagSends`, whose claim writes `nag_sends`), like
 * slot-nags.ts.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { getPriorityOption, HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'
import { parseHHMM } from '@/lib/time-slot-assign'
import { openTaskDayOf, openTaskDaySpan, periodOpensAt } from '@/lib/opentask-day'
import { listTimeSlots } from '@/core/time-slots'
import { getRemindersBySlot, getTodaysReminders } from '@/core/tasks/reminders'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { APP_URL } from '@/core/notifications/format'
import {
  isApnsConfigured,
  reminderCollapseId,
  sendApnsReminderNag,
} from '@/core/notifications/apns'
import { isWebPushConfigured, sendPushNotification } from '@/core/notifications/web-push'
import { mergeSettled, type DeliveryResult } from '@/core/notifications/delivery-result'
import { notifiableUsers } from '@/core/notifications/notifiable-users'
import { nagIntervalMinutes, userNagTiers } from '@/core/notifications/nag-ladder'
import { claimNagSend, nagSendDue } from '@/core/notifications/nag-sends'
import {
  NAMED_REMINDER_MIN_PRIORITY,
  isNamedReminderPriority,
} from '@/core/notifications/reminder-nag-rule'
import {
  runTick,
  type Channels,
  type Delivery,
  type PushKind,
  type SourcePlan,
  type TickSource,
} from '@/core/notifications/tick'

/** The `nag_sends` key prefix: `reminder-<taskId>`. */
export const REMINDER_NAG_KEY_PREFIX = 'reminder-'

export function reminderNagKey(taskId: number): string {
  return `${REMINDER_NAG_KEY_PREFIX}${taskId}`
}

/** The Web Push "Considered" button (public/sw.js handles `considered`). */
export const CONSIDERED_ACTION = { action: 'considered', title: 'Considered' } as const

export interface PendingReminderNag {
  userId: number
  taskId: number
  title: string
  priority: number
  slotLabel: string
  /** The OpenTask date (yyyy-MM-dd) of the roster it is waiting in. */
  reminderDay: string
  /** When its period opened today: the `since` floor of the claim. */
  periodOpenedAt: Date
  /** The slot nag's rung for its priority (minutes). */
  intervalMinutes: number
  /** The user's zone, whose clock marks the repeats land on. */
  timezone: string
}

/** The tick's kind for a named reminder push (its place in `LEAD_ORDER`). */
export function reminderKind(priority: number): PushKind {
  if (priority >= URGENT_PRIORITY) return 'reminder_urgent'
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'reminder_high'
  return 'reminder_medium'
}

/** High and Urgent sound; Medium is silent (and so never leads a sounding minute). */
export function reminderSounds(priority: number): boolean {
  return priority >= HIGH_PRIORITY_THRESHOLD
}

/** "Morning · High reminder". */
export function reminderNagBody(slotLabel: string, priority: number): string {
  return `${slotLabel} · ${getPriorityOption(priority).label} reminder`
}

/**
 * Whether the user has any reminder that could be pushed by name — one
 * statement, so the roster is only read for a user who has one.
 */
function hasNamedReminderCandidate(userId: number): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM tasks
       WHERE user_id = ? AND is_reminder = 1 AND done = 0
         AND deleted_at IS NULL AND archived_at IS NULL
         AND priority >= ?
         AND (auto_snooze_minutes IS NULL OR auto_snooze_minutes != 0)
       LIMIT 1`,
    )
    .get(userId, NAMED_REMINDER_MIN_PRIORITY)
}

/**
 * Every named reminder push due this minute (read-only). The claim is
 * `planReminderNagSends`'s.
 */
export function pendingReminderNags(now: Date = new Date()): PendingReminderNag[] {
  const pending: PendingReminderNag[] = []
  for (const user of notifiableUsers()) {
    if (!hasNamedReminderCandidate(user.id)) continue

    // Which of today's periods have opened (the OpenTask day, the Reminders
    // screen's own: `reminderDay` reads the same boundary). None yet: the
    // roster need not be read.
    const dayStart = dayBoundaryForUser(user.id)
    const day = openTaskDaySpan(now, user.timezone, dayStart)
    const opened = new Map<number, Date>()
    for (const slot of listTimeSlots(user.id)) {
      if (parseHHMM(slot.start_time) === null) continue
      const at = periodOpensAt(day.date, slot.start_time, user.timezone, dayStart)
      if (at.getTime() <= now.getTime()) opened.set(slot.id, at)
    }
    if (opened.size === 0) continue

    const tiers = userNagTiers(user.id)
    for (const group of getRemindersBySlot(user.id, user.timezone, now)) {
      // Anytime (no slot) never opens; a period still ahead has not opened.
      const openedAt = group.slot ? opened.get(group.slot.id) : undefined
      if (!group.slot || !openedAt) continue
      for (const task of group.reminders) {
        const priority = task.priority ?? 0
        if (!isNamedReminderPriority(priority)) continue
        if (task.auto_snooze_minutes === 0) continue
        const interval = nagIntervalMinutes('slot_nag', priority, tiers)
        if (interval <= 0) continue
        const key = reminderNagKey(task.id)
        if (!nagSendDue(user.id, key, interval, now, user.timezone, openedAt)) continue
        pending.push({
          userId: user.id,
          taskId: task.id,
          title: task.title,
          priority,
          slotLabel: group.slot.label,
          reminderDay: day.date,
          periodOpenedAt: openedAt,
          intervalMinutes: interval,
          timezone: user.timezone,
        })
      }
    }
  }
  return pending
}

/**
 * The Web Push banner: the APNs push's words and data, the "Considered"
 * button, tag `reminder-<id>`. High and Urgent renotify (a tagged repeat
 * otherwise lands silently); Medium, or a passive banner, is silent.
 */
async function sendReminderWebPush(
  nag: PendingReminderNag,
  body: string,
  delivery: Delivery,
): Promise<DeliveryResult> {
  const sounds = reminderSounds(nag.priority) && !delivery.passive
  return sendPushNotification(nag.userId, {
    title: nag.title,
    body,
    data: { url: `${APP_URL}/reminders`, taskId: nag.taskId, reminder_day: nag.reminderDay },
    tag: reminderCollapseId(nag.taskId),
    actions: [{ ...CONSIDERED_ACTION }],
    ...(sounds ? { renotify: true } : { silent: true }),
  })
}

/** Deliver one named reminder push on the channels that are on. */
async function sendReminderNag(
  nag: PendingReminderNag,
  channels: Channels,
  delivery: Delivery,
): Promise<DeliveryResult> {
  const body = reminderNagBody(nag.slotLabel, nag.priority) + (delivery.suffix ?? '')
  const sends: Promise<DeliveryResult>[] = []
  if (channels.webPush) sends.push(sendReminderWebPush(nag, body, delivery))
  if (channels.apns) {
    sends.push(
      sendApnsReminderNag(nag.userId, {
        taskId: nag.taskId,
        title: nag.title,
        body,
        reminderDay: nag.reminderDay,
        sound: reminderSounds(nag.priority),
        passive: delivery.passive,
      }),
    )
  }
  const settled = await Promise.allSettled(sends)
  for (const r of settled) {
    if (r.status === 'rejected') log.error('notifications', 'Reminder push error:', r.reason)
  }
  return mergeSettled(settled)
}

/**
 * This minute's named reminder pushes as tick sends (tick.ts). The claim is
 * the `nag_sends` compare-and-swap, floored at the period's open.
 */
export function planReminderNagSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.webPush && !channels.apns) return { sends: [] }
  return {
    sends: pendingReminderNags(now).map((nag) => ({
      userId: nag.userId,
      kind: reminderKind(nag.priority),
      items: 1,
      // Medium makes no sound: it never leads a minute in which something sounds.
      silent: !reminderSounds(nag.priority),
      claim: () => {
        const won = claimNagSend(
          nag.userId,
          reminderNagKey(nag.taskId),
          nag.intervalMinutes,
          now,
          nag.timezone,
          nag.periodOpenedAt,
        )
        if (won) {
          log.info(
            'notifications',
            `Reminder push for user ${nag.userId}: task ${nag.taskId}, every ${nag.intervalMinutes} min`,
          )
        }
        return won
      },
      deliver: (delivery) => sendReminderNag(nag, channels, delivery),
    })),
  }
}

/** The named reminder pushes as one of the minute tick's sources. */
export const REMINDER_NAG_SOURCE: TickSource = {
  name: 'Reminder push checker',
  minuteKey: 'tick-reminder-nags',
  plan: planReminderNagSends,
}

/** The named reminder pushes on their own (tests): one tick with this source alone. */
export async function checkReminderNags(nowOverride?: Date): Promise<void> {
  if (!isWebPushConfigured() && !isApnsConfigured()) return
  await runTick([REMINDER_NAG_SOURCE], nowOverride ?? new Date())
}

/**
 * THE CONSIDERED BUTTON'S DAY GUARD (POST /api/notifications/actions with
 * `day`). A named reminder push carries the OpenTask date it was waiting on
 * (`reminder_day`), and the button sends it back. Considering is `markDone`,
 * which on a repeating reminder ADVANCES its occurrence — so a push from
 * another day, or for a reminder no longer waiting (considered elsewhere,
 * or no reminder at all), must change nothing. True only when `day` is the
 * user's current OpenTask day (`reminderDay`'s boundary) and the task is
 * waiting in that day's roster.
 */
export function reminderWaitingOn(
  userId: number,
  timezone: string,
  taskId: number,
  day: string,
  now: Date = new Date(),
): boolean {
  if (openTaskDayOf(now, timezone, dayBoundaryForUser(userId)) !== day) return false
  return getTodaysReminders(userId, timezone, now).some((t) => t.id === taskId)
}

/**
 * The weekly purge: drop the `reminder-<id>` rows of reminders that are gone
 * — the task no longer exists, is in the trash, is done (a one-off
 * considered), or is no longer a reminder. A reminder still around keeps its
 * row, however long since it last sent: the period's open floors it.
 */
export function purgeGoneReminderNags(): number {
  const result = getDb()
    .prepare(
      `DELETE FROM nag_sends
       WHERE key LIKE '${REMINDER_NAG_KEY_PREFIX}%'
         AND NOT EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.id = CAST(substr(nag_sends.key, ${REMINDER_NAG_KEY_PREFIX.length + 1}) AS INTEGER)
             AND t.user_id = nag_sends.user_id
             AND t.is_reminder = 1 AND t.done = 0 AND t.deleted_at IS NULL
         )`,
    )
    .run()
  if (result.changes > 0) {
    log.info('cron', `Deleted ${result.changes} reminder push records of reminders that are gone`)
  }
  return result.changes
}
