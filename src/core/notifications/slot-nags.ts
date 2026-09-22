/**
 * Hourly nag for unfinished reminder slots
 *
 * WHAT THIS IS: on the hour, while the user is awake, if any time slot that has
 * already opened today still has reminders waiting, send ONE notification. Not
 * one per slot — one, total, naming the most recent unfinished slot and
 * counting the rest.
 *
 * WHY IT LOOKS LIKE A BUG: REDESIGN-V03 §6 says a reminder carries no debt, and
 * `slot-reminders.ts` states the principle outright — "a missed slot is a missed
 * thought", "deliberately no roll-forward and no catch-up". This module is a
 * CONSCIOUS EXCEPTION to that, requested by Trent on 2026-09-21:
 *
 *   "Top-of-the-hour reminders for each set of reminders that hasn't been
 *    done... but I don't want multiple reminders. At most you're getting one
 *    reminder nag, regardless of how many time periods of the reminders are
 *    undone."
 *
 * Do not delete it as a §6 violation. It is the exception, on purpose.
 *
 * HOW FAR THE EXCEPTION GOES — this is the whole of it, and nothing here may
 * grow past this line:
 * - The nag NEVER marks anything overdue. It writes nothing to any task.
 * - The nag NEVER enters the badge, and never changes an overdue count.
 * - The nag NEVER fires for a slot that has not yet opened today. It only ever
 *   re-surfaces something whose moment has already passed.
 * - The nag NEVER accumulates. It is capped at MAX_NAGS_PER_DAY and resets with
 *   the local date; nothing rolls forward to tomorrow.
 * - A reminder is still never notified individually. The SLOT is still the unit.
 *
 * So the debt-free property that §6 is protecting — that a missed reminder costs
 * nothing, leaves no residue, and resets at its next occurrence — survives
 * intact. What changed is only how many times a day the app is willing to say
 * "these are still sitting there", and the answer is at most three.
 *
 * DESIGN: mirrors `slot-reminders.ts` — a pure, read-only decision function
 * (`pendingSlotNags`) split from the sender (`checkSlotNags`), so the decision
 * is testable without APNs credentials. The one piece of state (`slot_nags`) is
 * the daily cap, because a cap is the only thing here a clock cannot derive.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { isApnsConfigured, sendApnsSlotReminder } from '@/core/notifications/apns'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { listTimeSlots } from '@/core/time-slots'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

/** At most three a day. Past that it is noise, and noise is what §6 avoids. */
export const MAX_NAGS_PER_DAY = 3

const DEFAULT_RETENTION_DAYS = 30

interface NaggableUser {
  id: number
  timezone: string
  wake_time: string
  sleep_time: string
}

/**
 * Is `minutes` (minutes past local midnight) inside the user's waking window?
 *
 * At or after wake, strictly before sleep. The strict upper edge means a
 * 22:00 sleep_time makes 21:00 the last nag of the day, which is the reading
 * Trent asked for ("at or after wake_time and strictly before sleep_time").
 *
 * WINDOW CROSSING MIDNIGHT (wake 07:00, sleep 02:00): a sleep_time at or before
 * wake_time is treated as wrapping past midnight, so the window is
 * [wake, 24:00) ∪ [00:00, sleep). The alternative — treating it as an empty
 * window — would silently disable the feature for a night-owl schedule, and
 * failing silent is the worse of the two. A degenerate wake == sleep therefore
 * falls out of the same formula as "awake all day", which is the same
 * fail-loud-not-silent choice.
 */
export function isAwake(minutes: number, wakeTime: string, sleepTime: string): boolean {
  const wake = parseHHMM(wakeTime)
  const sleep = parseHHMM(sleepTime)
  // A malformed HH:MM in the DB must not turn into a 3am notification.
  if (wake === null || sleep === null) return false

  if (sleep > wake) return minutes >= wake && minutes < sleep
  return minutes >= wake || minutes < sleep
}

interface UnfinishedSlot {
  slot: TimeSlot
  count: number
  start: number
}

/**
 * The slots that have already opened today and still have reminders waiting,
 * latest-opening first.
 *
 * The un-slotted ("Anytime today") group is deliberately excluded: it has no
 * `start_time`, so it never "opens", and there is no moment it could be said to
 * have been missed. It is therefore neither a trigger nor a target nor part of
 * the "N earlier slots" count.
 */
function unfinishedOpenedSlots(
  user: NaggableUser,
  now: Date,
  minuteOfDay: number,
): UnfinishedSlot[] {
  const slots = listTimeSlots(user.id)
  if (slots.length === 0) return []

  const groups = getRemindersBySlot(user.id, user.timezone, now)
  const unfinished: UnfinishedSlot[] = []

  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minuteOfDay) continue

    const group = groups.find((g) => g.slot?.id === slot.id)
    if (!group || group.reminders.length === 0) continue

    unfinished.push({ slot, count: group.reminders.length, start })
  }

  return unfinished.sort((a, b) => b.start - a.start)
}

/** Has a slot opened on this exact minute? Then it sends its own push — stay quiet. */
function aSlotOpensThisMinute(userId: number, minuteOfDay: number): boolean {
  return listTimeSlots(userId).some((slot) => parseHHMM(slot.start_time) === minuteOfDay)
}

export interface PendingSlotNag {
  userId: number
  /** The most recent unfinished slot — the one the notification names. */
  slotId: number
  slotLabel: string
  /** Reminders waiting in that slot. */
  count: number
  /** How many OTHER opened slots are also unfinished. Never enumerated. */
  otherSlots: number
  /** The user's local date, so the sender claims against the same day it decided on. */
  localDate: string
  /** The user's local hour, likewise. */
  localHour: number
}

/**
 * Every nag that should go out this minute — at most one per user.
 *
 * Read-only. `checkSlotNags` is what claims the day's allowance and sends.
 */
export function pendingSlotNags(now: Date = new Date()): PendingSlotNag[] {
  const users = getDb()
    .prepare(
      'SELECT id, timezone, wake_time, sleep_time FROM users WHERE notifications_enabled = 1',
    )
    .all() as NaggableUser[]

  const pending: PendingSlotNag[] = []

  for (const user of users) {
    const local = DateTime.fromJSDate(now).setZone(user.timezone)
    if (!local.isValid) continue

    // Top of the hour only.
    if (local.minute !== 0) continue

    const minuteOfDay = local.hour * 60 + local.minute
    if (!isAwake(minuteOfDay, user.wake_time, user.sleep_time)) continue

    // A slot opening on this exact minute already sends its own banner. Two in
    // one minute is precisely the thing this feature must not cause.
    if (aSlotOpensThisMinute(user.id, minuteOfDay)) continue

    const unfinished = unfinishedOpenedSlots(user, now, minuteOfDay)
    if (unfinished.length === 0) continue

    if (nagsSentToday(user.id, local.toISODate()!) >= MAX_NAGS_PER_DAY) continue

    const [target] = unfinished
    pending.push({
      userId: user.id,
      slotId: target.slot.id,
      slotLabel: target.slot.label,
      count: target.count,
      otherSlots: unfinished.length - 1,
      localDate: local.toISODate()!,
      localHour: local.hour,
    })
  }

  return pending
}

/**
 * The body text for a nag.
 *
 * The target slot gets named and counted; everything else is a bare count. The
 * user asked for one nag, not a digest — enumerating four slots in a banner is
 * a digest wearing a notification's clothes.
 */
export function slotNagBody(count: number, otherSlots: number): string {
  const waiting = count === 1 ? '1 reminder waiting' : `${count} reminders waiting`
  if (otherSlots <= 0) return waiting
  const others = otherSlots === 1 ? '1 earlier slot' : `${otherSlots} earlier slots`
  return `${waiting}, and ${others}`
}

function nagsSentToday(userId: number, localDate: string): number {
  const row = getDb()
    .prepare('SELECT sent_count FROM slot_nags WHERE user_id = ? AND local_date = ?')
    .get(userId, localDate) as { sent_count: number } | undefined
  return row?.sent_count ?? 0
}

/**
 * Claim one of the day's nags. Returns false if it was already claimed.
 *
 * Both guards live in the one statement so the claim is atomic:
 * - `last_hour != excluded.last_hour` — the minute sweep running twice in the
 *   same minute (or twice in the same hour) must not consume two of the three.
 *   An hourly grain is the right one: "top of the hour" already means at most
 *   one per local hour.
 * - `sent_count < MAX_NAGS_PER_DAY` — the cap itself, enforced at write time as
 *   well as at decision time.
 *
 * DST fall-back repeats a local hour, so on that one night a nag in the repeated
 * hour is skipped. That costs at most one nag, in the small hours, and is
 * preferable to the alternative of a minute-grained key that would let a
 * double-run through.
 */
export function recordSlotNag(userId: number, localDate: string, localHour: number): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO slot_nags (user_id, local_date, sent_count, last_hour)
            VALUES (@userId, @localDate, 1, @localHour)
       ON CONFLICT(user_id, local_date) DO UPDATE SET
            sent_count = sent_count + 1,
            last_hour  = excluded.last_hour
          WHERE slot_nags.last_hour != excluded.last_hour
            AND slot_nags.sent_count < @maxNags`,
    )
    .run({ userId, localDate, localHour, maxNags: MAX_NAGS_PER_DAY })

  return result.changes === 1
}

/** Cron entry point — runs on the same minute tick as the slot reminders. */
export async function checkSlotNags(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return

  try {
    for (const nag of pendingSlotNags(nowOverride ?? new Date())) {
      // Claim before sending: a claim that loses the race means another run of
      // this minute already sent, and sending anyway would double-notify.
      if (!recordSlotNag(nag.userId, nag.localDate, nag.localHour)) continue

      // Same category, same slot identity, same collapse key as the slot's own
      // push — so the long-press checklist, the deep link and the action
      // buttons all work with no iOS change, and the nag REPLACES that slot's
      // banner rather than stacking beside it.
      await sendApnsSlotReminder(nag.userId, {
        slotId: nag.slotId,
        slotLabel: nag.slotLabel,
        count: nag.count,
        body: slotNagBody(nag.count, nag.otherSlots),
      })
    }
  } catch (err) {
    log.error('notifications', 'Slot nag checker error:', err)
  }
}

/**
 * Drop old nag rows. Only today's row is ever read, so retention is purely
 * about not letting a plumbing table grow without bound.
 */
export function purgeOldSlotNags(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_SLOT_NAGS_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const cutoff = DateTime.utc().minus({ days: retentionDays }).toISODate()!
  const result = getDb().prepare('DELETE FROM slot_nags WHERE local_date < ?').run(cutoff)

  if (result.changes > 0) {
    log.info('cron', `Deleted ${result.changes} slot nag records older than ${retentionDays} days`)
  }

  return result.changes
}
