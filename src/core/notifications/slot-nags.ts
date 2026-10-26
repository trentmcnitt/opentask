/**
 * The nag for unfinished reminder slots
 *
 * WHAT THIS IS: while any time slot that has already opened today still has
 * reminders (or quota prompts) waiting, send ONE notification — not one per
 * slot — naming the most recent unfinished slot and counting the rest ("N
 * earlier slots"). It repeats at the nag ladder's considering pace
 * (nag-ladder.ts, `slot_nag`: the user's overdue tier ×2 — Urgent 10, High
 * 30, Medium 120, Low 480, Unset 60 by default).
 *
 * PRIORITY PACES IT (Trent, 2026-10-22). Every waiting item the nag covers —
 * each None/Low reminder (Medium+ ones have their own named push since
 * 2026-10-26, reminder-nags.ts, and are not the nag's: `waitingBySlot`), and
 * each quota prompt at its quota's priority, in EVERY
 * unfinished opened slot, not just the one it names — has its own rung; the
 * rung whose next clock mark comes FIRST wins (`nagPace`, nag-sends.ts — the
 * old "shortest interval wins", made exact for marks). Not highest priority:
 * the ladder is not monotonic (an Unset item, 60, outpaces a Medium one, 120,
 * with the shipped tiers, and the tiers are the user's to set). Finishing
 * the fast item drops the pace back to the next rung, counted from the last
 * send. Still ONE nag per user: priority sets how often, never how many.
 *
 * ON THE CLOCK MARKS (Trent, 2026-10-26; nag-marks.ts). The slot's own push
 * is exact — a period at 16:30 pushes at 16:30 — and every nag after it lands
 * on the local mark nearest the last send plus the interval (grid 60 for 60
 * and over, else the largest divisor of 60 ≤ the interval; a tie to the
 * earlier mark). The worked handover, two periods at the shipped Unset pace
 * (60), both unfinished:
 *    16:30  After School opens and pushes (stamps the nag's clock)
 *    17:00  nag: After School (16:30 + 60 = 17:30, a tie → 17:00)
 *    18:00  Dinnertime opens and pushes; the nag stands down this minute and
 *           the push stamps its clock — no After School nag at 18:00
 *    19:00  nag: Dinnertime, "and 1 earlier slot"
 * The nag no longer comes "one interval after, at any minute" (2026-10-22 to
 * 10-26); a 20:15 period's nag comes at 21:00. tests/behavioral/dn-tick.test.ts
 * (DN-T05) plays this handover through the whole minute tick.
 *
 * THE 2026-10-22 RULING (Trent): one considering ladder, no special cases.
 * The rules this module used to carry are gone, on purpose:
 *  - no 3-a-day cap, no derived gap and no evening reserve — the ladder's
 *    interval (on its marks) is the gap;
 *  - no Wake–Sleep window — OpenTask has no time-of-day behaviour; the
 *    phone's sleep mode handles nights. (Marks are not a time-of-day rule:
 *    they place a repeat, never hold one back.)
 *  - no sound — a silent banner (ruling 5: sound only on overdue), like the
 *    slot-open push.
 * Do not add them back without Trent.
 *
 * ONE ALERT PER TICK (2026-10-26, tick.ts). The nag is a `period` send of the
 * minute's tick, silent by its own rule: when an overdue push sounds in the
 * same minute it leads, and the nag still goes out but passive. Among silent
 * sends only, a deadlines safety net outranks it.
 *
 * WHY IT LOOKS LIKE A BUG: REDESIGN-V03 §6 says a reminder carries no debt,
 * and `slot-reminders.ts` states the principle outright — "a missed slot is a
 * missed thought". This module is a CONSCIOUS EXCEPTION to that, requested by
 * Trent on 2026-09-21 ("Top-of-the-hour reminders for each set of reminders
 * that hasn't been done... At most you're getting one reminder nag"). Do not
 * delete it as a §6 violation. What still holds:
 * - The nag NEVER marks anything overdue. It writes nothing to any task.
 * - The nag NEVER enters the badge, and never changes an overdue count.
 * - The nag NEVER fires for a slot that has not yet opened today (the
 *   OpenTask day — see THE DAY).
 * - Nothing rolls forward: finishing a slot (considered or done) silences it,
 *   and the next day's roster starts clean at the day start (silencing =
 *   acting).
 * - A None or Low reminder is never notified individually: the SLOT is the
 *   unit. (Medium+ reminders are, since 2026-10-26 — by reminder-nags.ts,
 *   not here.)
 *
 * THE DAY (2026-10-23, "one day boundary everywhere"). Slots are counted as
 * opened within the Reminders screen's own day (`reminderDay`: the user's
 * "Day starts at" with the task queue's switch on, midnight with it off).
 * Between local midnight and the day start it is still the evening's day:
 * every slot of it has opened, and what is still waiting there keeps the nag
 * going until the day starts (Trent: yesterday's unfinished evening slot
 * keeps nagging until the day starts) — then the new day's roster starts
 * clean and nothing of it has opened until its first slot. A slot that
 * starts before the day start (1:00 AM, the day starting at 3:00) opens at
 * the END of its day (`periodOpensAt`). Which reminders are waiting is the
 * Reminders surface's own roster (`waitingBySlot`), read at `now`.
 *
 * PACING: `nag_sends` (key `slot-nag`). The slot-open push stamps it too
 * (`planSlotReminderSends`), so the nag waits for the mark after a slot's own
 * banner instead of following it a minute later; a slot opening this exact
 * minute also stands the nag down (`usersNotifiedThisMinute`). The interval
 * depends on what is waiting, so the cheap gate asks first whether ANY rung's
 * mark has come (`nagPace` over every rung); only then is the roster read and
 * the real pace checked.
 *
 * DESIGN: a pure, read-only decision function (`pendingSlotNags`) split from
 * the tick source (`planSlotNagSends`, whose claim is the `nag_sends`
 * compare-and-swap), so the decision is testable without APNs.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { log } from '@/lib/logger'
import { isApnsConfigured, sendApnsSlotReminder, slotWaitingBody } from '@/core/notifications/apns'
import { pendingSlotNotifications, waitingBySlot } from '@/core/notifications/slot-reminders'
import { listTimeSlots } from '@/core/time-slots'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { openTaskDaySpan, periodOpensAt } from '@/lib/opentask-day'
import { notifiableUsers, type NotifiableUser } from '@/core/notifications/notifiable-users'
import { nagIntervalMinutes, userNagTiers, type NagTiers } from '@/core/notifications/nag-ladder'
import { claimNagSend, nagPace, nagSendDue, SLOT_NAG_KEY } from '@/core/notifications/nag-sends'
import { runTick, type Channels, type SourcePlan, type TickSource } from '@/core/notifications/tick'

const DEFAULT_RETENTION_DAYS = 30

/** Every priority the ladder has a rung for (Unset … Urgent). */
const PRIORITIES = [0, 1, 2, 3, 4]

interface UnfinishedSlot {
  slot: TimeSlot
  count: number
  promptCount: number
  /** The priority of each waiting item (`SlotWaiting.priorities`). */
  priorities: number[]
  /** When the slot opened in the day (ms). */
  opened: number
}

/** The slot nag's rung (minutes) for each of these waiting items' priorities. */
function slotNagRungs(priorities: number[], tiers: NagTiers): number[] {
  return [...new Set(priorities.map((p) => nagIntervalMinutes('slot_nag', p, tiers)))]
}

/**
 * The slots that have already opened today and still have reminders — or
 * quota prompts — waiting, latest-opening first. A prompt keeps its slot
 * unfinished exactly as a reminder does, until it is considered or done.
 *
 * The un-slotted ("Anytime today") group is deliberately excluded: it has no
 * `start_time`, so it never "opens", and there is no moment it could be said
 * to have been missed.
 */
function unfinishedOpenedSlots(
  user: NotifiableUser,
  slots: TimeSlot[],
  now: Date,
): UnfinishedSlot[] {
  if (slots.length === 0) return []

  const dayStart = dayBoundaryForUser(user.id)
  const day = openTaskDaySpan(now, user.timezone, dayStart)
  const opened = (slot: TimeSlot) =>
    periodOpensAt(day.date, slot.start_time, user.timezone, dayStart).getTime()
  // Nothing of the day has opened yet (its first slot is still ahead): the
  // roster need not be read.
  if (!slots.some((slot) => parseHHMM(slot.start_time) !== null && opened(slot) <= now.getTime())) {
    return []
  }

  const waiting = waitingBySlot(user.id, user.timezone, now)
  const unfinished: UnfinishedSlot[] = []

  for (const slot of slots) {
    if (parseHHMM(slot.start_time) === null) continue
    const openedAt = opened(slot)
    if (openedAt > now.getTime()) continue

    const inSlot = waiting.get(slot.id)
    if (!inSlot || inSlot.reminders + inSlot.prompts === 0) continue

    unfinished.push({
      slot,
      count: inSlot.reminders,
      promptCount: inSlot.prompts,
      priorities: inSlot.priorities,
      opened: openedAt,
    })
  }

  return unfinished.sort((a, b) => b.opened - a.opened)
}

/**
 * The users who are getting a slot-open push on this exact minute — asked of
 * the sender's own decision function, so an EMPTY slot opening (which stays
 * silent) doesn't stand the nag down.
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
  /** Every item waiting in every unfinished opened slot (the tick's "N more"). */
  itemCount: number
  /** The ladder's interval this nag is paced at (minutes): the rung whose mark came first. */
  intervalMinutes: number
  /** The user's zone, whose clock marks the nag lands on. */
  timezone: string
}

/** Whether `user`'s slot nag could be due at `now` at all: is any rung's mark here? */
function anyRungDue(user: NotifiableUser, tiers: NagTiers, now: Date): boolean {
  const pace = nagPace(user.id, SLOT_NAG_KEY, slotNagRungs(PRIORITIES, tiers), user.timezone)
  return pace !== null && nagSendDue(user.id, SLOT_NAG_KEY, pace, now, user.timezone)
}

/**
 * Every nag that should go out this minute — at most one per user.
 *
 * Read-only. `planSlotNagSends` is what claims the send for the tick.
 */
export function pendingSlotNags(now: Date = new Date()): PendingSlotNag[] {
  const pending: PendingSlotNag[] = []
  // Computed once rather than per user: it answers for every user at once.
  const alreadyNotified = usersNotifiedThisMinute(now)

  for (const user of notifiableUsers()) {
    // The cheap gates first: the clock against `nag_sends` at every rung (if
    // no rung's mark has come, nothing waiting could be due), then the
    // same-minute slot push. Only then the slots and their contents.
    const tiers = userNagTiers(user.id)
    if (!anyRungDue(user, tiers, now)) continue
    if (alreadyNotified.has(user.id)) continue

    const slots = listTimeSlots(user.id)
    const unfinished = unfinishedOpenedSlots(user, slots, now)
    if (unfinished.length === 0) continue

    // The real pace: of everything this nag covers, the rung whose mark comes first.
    const rungs = slotNagRungs(
      unfinished.flatMap((u) => u.priorities),
      tiers,
    )
    const interval = nagPace(user.id, SLOT_NAG_KEY, rungs, user.timezone)
    if (interval === null || !nagSendDue(user.id, SLOT_NAG_KEY, interval, now, user.timezone)) {
      continue
    }

    const [target] = unfinished
    pending.push({
      userId: user.id,
      slotId: target.slot.id,
      slotLabel: target.slot.label,
      count: target.count,
      promptCount: target.promptCount,
      otherSlots: unfinished.length - 1,
      itemCount: unfinished.reduce((n, u) => n + u.count + u.promptCount, 0),
      intervalMinutes: interval,
      timezone: user.timezone,
    })
  }

  return pending
}

/**
 * The body text for a nag. The target slot gets named and counted; everything
 * else is a bare count — one nag, not a digest.
 */
export function slotNagBody(count: number, promptCount: number, otherSlots: number): string {
  const waiting = slotWaitingBody(count, promptCount)
  if (otherSlots <= 0) return waiting
  const others = otherSlots === 1 ? '1 earlier slot' : `${otherSlots} earlier slots`
  return `${waiting}, and ${others}`
}

/**
 * This minute's slot nags as tick sends (tick.ts), APNs only. Kind `period`.
 * The claim is the `nag_sends` compare-and-swap: a lost claim means this
 * minute already sent. Planned AFTER the slot-open push in the tick, whose
 * claim stamps the same clock.
 */
export function planSlotNagSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.apns) return { sends: [] }
  return {
    sends: pendingSlotNags(now).map((nag) => ({
      userId: nag.userId,
      kind: 'period',
      items: nag.itemCount,
      // A silent banner (ruling 5): never leads a minute something sounds in.
      silent: true,
      claim: () => claimNagSend(nag.userId, SLOT_NAG_KEY, nag.intervalMinutes, now, nag.timezone),
      // Same category, same slot identity, same collapse key as the slot's own
      // push — so the long-press checklist, the deep link and the action
      // buttons all work with no iOS change, and the nag REPLACES that slot's
      // banner rather than stacking beside it.
      deliver: (delivery) =>
        sendApnsSlotReminder(nag.userId, {
          slotId: nag.slotId,
          slotLabel: nag.slotLabel,
          count: nag.count,
          promptCount: nag.promptCount,
          body: slotNagBody(nag.count, nag.promptCount, nag.otherSlots),
          suffix: delivery.suffix ?? undefined,
          passive: delivery.passive,
        }),
    })),
  }
}

/** The slot nag as one of the minute tick's sources. */
export const SLOT_NAG_SOURCE: TickSource = {
  name: 'Slot nag checker',
  minuteKey: 'tick-slot-nag',
  plan: planSlotNagSends,
}

/** The slot nag on its own (tests): one tick with this source alone. */
export async function checkSlotNags(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return
  await runTick([SLOT_NAG_SOURCE], nowOverride ?? new Date())
}

/**
 * Drop old `slot_nags` rows. Nothing writes that table since 2026-10-22 (the
 * nag paces through `nag_sends`); this drains what is left, after which the
 * table can be dropped.
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
