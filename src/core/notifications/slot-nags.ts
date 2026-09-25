/**
 * Hourly nag for unfinished reminder slots
 *
 * WHAT THIS IS: on the hour, while the user is awake, if any time slot that has
 * already opened today still has reminders (or quota prompts) waiting, send
 * ONE notification. Not one per slot — one, total, naming the most recent
 * unfinished slot and counting the rest. At most MAX_NAGS_PER_DAY a day,
 * spaced out across the user's waking window (`minNagGapHours`), with the last one held back until
 * the day's final slot has opened (`allowanceSoFar`). Those two rules exist
 * because firing as early as possible spent the whole day on the morning.
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
 * the daily count and the hour of the last nag, because how many have been sent
 * and how long ago are the only two things here a clock cannot derive.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { isApnsConfigured, sendApnsSlotReminder, slotWaitingBody } from '@/core/notifications/apns'
import { pendingSlotNotifications, waitingBySlot } from '@/core/notifications/slot-reminders'
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

const MINUTES_PER_DAY = 24 * 60

/**
 * How long the user is awake, in minutes. Null if either time is malformed.
 *
 * Same wrap rule as `isAwake`, from the same two fields, so the window the gap
 * is derived from is by construction the window the nag is allowed to fire in.
 */
export function wakingWindowMinutes(wakeTime: string, sleepTime: string): number | null {
  const wake = parseHHMM(wakeTime)
  const sleep = parseHHMM(sleepTime)
  if (wake === null || sleep === null) return null

  return sleep > wake ? sleep - wake : MINUTES_PER_DAY - wake + sleep
}

/**
 * The minimum gap between two nags on the same day, in whole hours.
 *
 * WHY THIS IS DERIVED AND NOT A CONSTANT: without a gap, the rules fire as
 * early as they possibly can, and "as early as possible" spends the whole day's
 * allowance in the first few hours. With the default 07:00-22:00 window and one
 * unfinished morning slot, the un-spaced version nagged at 08:00, 10:00 and
 * 11:00 and was then silent for the remaining eleven hours — three nudges about
 * the morning, none about the rest of the day. That was the failure mode
 * (Trent, 2026-09-21); do not replace this with a constant without re-reading
 * that sentence.
 *
 * Spreading the allowance across the waking window instead means
 * `floor(windowHours / MAX_NAGS_PER_DAY)`, which self-adjusts to whatever
 * wake/sleep the user sets — a short window keeps its full allowance at a
 * tighter spacing rather than losing nags. The floor of 1 hour keeps a
 * degenerately short window from collapsing the gap to zero.
 *
 * Hour granularity is exact here, not a rounding: a nag can only ever fire at
 * minute 0, so two nags on the same local day are always a whole number of
 * hours apart and `hour - last_hour` has no boundary ambiguity.
 */
export function minNagGapHours(wakeTime: string, sleepTime: string): number {
  const window = wakingWindowMinutes(wakeTime, sleepTime)
  // Malformed times never pass `isAwake` anyway; a full day is the safe answer.
  if (window === null) return 24

  return Math.max(1, Math.floor(window / 60 / MAX_NAGS_PER_DAY))
}

interface UnfinishedSlot {
  slot: TimeSlot
  count: number
  promptCount: number
  start: number
}

/**
 * The slots that have already opened today and still have reminders — or
 * quota prompts — waiting, latest-opening first. A prompt keeps its slot
 * unfinished exactly as a reminder does, until it is considered or done
 * (quota reminders, 2026-09-24; see `waitingBySlot`).
 *
 * The un-slotted ("Anytime today") group is deliberately excluded: it has no
 * `start_time`, so it never "opens", and there is no moment it could be said to
 * have been missed. It is therefore neither a trigger nor a target nor part of
 * the "N earlier slots" count.
 */
function unfinishedOpenedSlots(
  user: NaggableUser,
  slots: TimeSlot[],
  now: Date,
  minuteOfDay: number,
): UnfinishedSlot[] {
  if (slots.length === 0) return []

  const waiting = waitingBySlot(user.id, user.timezone, now)
  const unfinished: UnfinishedSlot[] = []

  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minuteOfDay) continue

    const inSlot = waiting.get(slot.id)
    if (!inSlot || inSlot.reminders + inSlot.prompts === 0) continue

    unfinished.push({ slot, count: inSlot.reminders, promptCount: inSlot.prompts, start })
  }

  return unfinished.sort((a, b) => b.start - a.start)
}

/**
 * How many nags the day may have spent by now.
 *
 * THE RESERVE: one of the day's nags is held back until the LAST slot has
 * opened, so a morning miss cannot spend the whole allowance before the evening
 * exists. Without it the default window fired at 08:00 / 13:00 / 18:00 and went
 * quiet — three nudges about the morning and none about the evening, on a
 * feature whose entire job is "these are still sitting there" (Trent,
 * 2026-09-21).
 *
 * The boundary is the greatest `start_time` among the user's slots, REGARDLESS
 * of what is in it: this is a question about the time of day, not about
 * content. The un-slotted group has no start time and stays excluded, as
 * everywhere else here.
 *
 * IF THE RESERVED NAG NEVER GETS SPENT, THAT IS THE POINT. A day where nothing
 * is undone once the last slot opens should end with an unspent nag — that is
 * the feature working, not waste. Do not "fix" it by releasing the reserve
 * early; releasing it early is precisely the behaviour this replaced.
 *
 * THE ONE GUARD: if the last slot starts at a time the user is never awake
 * (sleep_time before the last slot's start), the reserve could never be spent
 * at all, and holding it back would silently cost a real nag every day rather
 * than deferring one. In that case there is no boundary to wait for, so the
 * full allowance stays available.
 */
function allowanceSoFar(user: NaggableUser, slots: TimeSlot[], minuteOfDay: number): number {
  const starts = slots
    .map((slot) => parseHHMM(slot.start_time))
    .filter((minutes): minutes is number => minutes !== null)
  if (starts.length === 0) return MAX_NAGS_PER_DAY

  const lastStart = Math.max(...starts)
  if (!isAwake(lastStart, user.wake_time, user.sleep_time)) return MAX_NAGS_PER_DAY

  return minuteOfDay >= lastStart ? MAX_NAGS_PER_DAY : MAX_NAGS_PER_DAY - 1
}

/**
 * The users who are getting a slot-open push on this exact minute.
 *
 * WHY THIS ASKS `pendingSlotNotifications` RATHER THAN CHECKING START TIMES:
 * the suppression exists for exactly one reason — a slot opening this minute
 * sends its own banner, and two banners in one minute is the thing this feature
 * must not cause. But the slot-open path deliberately stays SILENT for an empty
 * slot ("an empty checklist is a notification that costs attention and returns
 * nothing"). So a slot that opens this minute with nothing in it produces no
 * competing banner, and suppressing the nag for it would cost a legitimate
 * nudge and buy nothing — 09:00 with Morning empty and Early morning still
 * unfinished should nag.
 *
 * That makes the condition "a slot would ACTUALLY notify now", not "a slot
 * starts now". Asking the sender's own decision function is the only way to
 * state that without re-deriving the emptiness rule here, where it could
 * silently drift out of step. If the empty-slot rule in `slot-reminders.ts`
 * ever changes, this follows it for free — which is the point.
 */
function usersNotifiedThisMinute(now: Date): Set<number> {
  return new Set(pendingSlotNotifications(now).map((n) => n.userId))
}

export interface PendingSlotNag {
  userId: number
  /** The most recent unfinished slot — the one the notification names. */
  slotId: number
  slotLabel: string
  /** Reminders waiting in that slot. */
  count: number
  /** Quota prompts waiting in that slot. */
  promptCount: number
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
  // Computed once rather than per user: it answers for every user at once, and
  // asking it inside the loop would re-scan every user's slots N times.
  const alreadyNotified = usersNotifiedThisMinute(now)

  for (const user of users) {
    const local = DateTime.fromJSDate(now).setZone(user.timezone)
    if (!local.isValid) continue

    // Top of the hour only.
    if (local.minute !== 0) continue

    const minuteOfDay = local.hour * 60 + local.minute
    if (!isAwake(minuteOfDay, user.wake_time, user.sleep_time)) continue

    // A slot that is notifying on this exact minute already puts a banner up.
    // Two in one minute is precisely the thing this feature must not cause.
    if (alreadyNotified.has(user.id)) continue

    const slots = listTimeSlots(user.id)

    // Three independent gates, ALL of which must pass. The cap bounds how many
    // nags a day holds; the gap bounds how fast they are spent; the reserve
    // bounds how many may be spent before the evening exists. Each one alone
    // was insufficient — see `minNagGapHours` and `allowanceSoFar`. Checked
    // BEFORE the slots' contents: they need only the clock and the nag row,
    // and a user whose day is spent should not cost a reminders-and-quotas read.
    const sentToday = todaysNagRow(user.id, local.toISODate()!)
    if (sentToday && sentToday.sent_count >= allowanceSoFar(user, slots, minuteOfDay)) continue
    if (
      sentToday &&
      local.hour - sentToday.last_hour < minNagGapHours(user.wake_time, user.sleep_time)
    ) {
      continue
    }

    const unfinished = unfinishedOpenedSlots(user, slots, now, minuteOfDay)
    if (unfinished.length === 0) continue

    const [target] = unfinished
    pending.push({
      userId: user.id,
      slotId: target.slot.id,
      slotLabel: target.slot.label,
      count: target.count,
      promptCount: target.promptCount,
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
export function slotNagBody(count: number, promptCount: number, otherSlots: number): string {
  const waiting = slotWaitingBody(count, promptCount)
  if (otherSlots <= 0) return waiting
  const others = otherSlots === 1 ? '1 earlier slot' : `${otherSlots} earlier slots`
  return `${waiting}, and ${others}`
}

/**
 * Today's nag row for a user, or undefined if they have not been nagged today.
 *
 * NOTE ON A MIDNIGHT-CROSSING WINDOW: the row is keyed by LOCAL DATE, so a
 * night-owl window (07:00-02:00) splits at midnight — a nag at 23:00 and one at
 * 01:00 are different rows, and the 01:00 one is therefore neither gap-limited
 * against the 23:00 one nor counted against its cap. That follows from "at most
 * N per local day", which is the rule as specified; flagging it here because it
 * is the one place the day boundary is visible.
 */
function todaysNagRow(
  userId: number,
  localDate: string,
): { sent_count: number; last_hour: number } | undefined {
  return getDb()
    .prepare('SELECT sent_count, last_hour FROM slot_nags WHERE user_id = ? AND local_date = ?')
    .get(userId, localDate) as { sent_count: number; last_hour: number } | undefined
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
        promptCount: nag.promptCount,
        body: slotNagBody(nag.count, nag.promptCount, nag.otherSlots),
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
