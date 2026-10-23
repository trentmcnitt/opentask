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
 * each reminder, and each quota prompt at its quota's priority, in EVERY
 * unfinished opened slot, not just the one it names — has its own rung; the
 * SHORTEST interval wins. Shortest interval, not highest priority: the
 * ladder is not monotonic (an Unset item, 60, outpaces a Medium one, 120,
 * with the shipped tiers, and the tiers are the user's to set). Finishing
 * the fast item drops the pace back to the next rung, counted from the last
 * send. Still ONE nag per user: priority sets how often, never how many.
 *
 * THE 2026-10-22 RULING (Trent): one considering ladder, no special cases.
 * The rules this module used to carry are gone, on purpose:
 *  - no 3-a-day cap, no derived gap and no evening reserve — the ladder's
 *    interval is the gap;
 *  - no Wake–Sleep window and no top-of-the-hour alignment — OpenTask has no
 *    time-of-day behaviour; the phone's sleep mode handles nights. The nag
 *    comes one interval after the slot's own push or the last nag.
 *  - no sound — a silent banner (ruling 5: sound only on overdue), like the
 *    slot-open push.
 * Do not add them back without Trent.
 *
 * WHY IT LOOKS LIKE A BUG: REDESIGN-V03 §6 says a reminder carries no debt,
 * and `slot-reminders.ts` states the principle outright — "a missed slot is a
 * missed thought". This module is a CONSCIOUS EXCEPTION to that, requested by
 * Trent on 2026-09-21 ("Top-of-the-hour reminders for each set of reminders
 * that hasn't been done... At most you're getting one reminder nag"). Do not
 * delete it as a §6 violation. What still holds:
 * - The nag NEVER marks anything overdue. It writes nothing to any task.
 * - The nag NEVER enters the badge, and never changes an overdue count.
 * - The nag NEVER fires for a slot that has not yet opened today.
 * - Nothing rolls forward: finishing a slot (considered or done) silences it,
 *   and the next day's roster starts clean (silencing = acting).
 * - A reminder is still never notified individually. The SLOT is the unit.
 *
 * THE DAY. Slots are counted as opened on the OpenTask day (it starts at the
 * rollover time, which is the earliest period's start): between local
 * midnight and the rollover nothing of the new day has opened, so the nag is
 * silent there. Which reminders are waiting is the Reminders surface's own
 * roster (`waitingBySlot`), read at `now`.
 *
 * PACING: `nag_sends` (key `slot-nag`). The slot-open push stamps it too
 * (`checkSlotReminders`), so the nag waits a full interval after a slot's own
 * banner instead of following it a minute later; a slot opening this exact
 * minute also stands the nag down (`usersNotifiedThisMinute`). The interval
 * depends on what is waiting, so the cheap gate asks first whether even the
 * FASTEST rung is due; only then is the roster read and the real interval
 * checked.
 *
 * DESIGN: a pure, read-only decision function (`pendingSlotNags`) split from
 * the sender (`checkSlotNags`), so the decision is testable without APNs.
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { log } from '@/lib/logger'
import { isApnsConfigured, sendApnsSlotReminder, slotWaitingBody } from '@/core/notifications/apns'
import { pendingSlotNotifications, waitingBySlot } from '@/core/notifications/slot-reminders'
import { listTimeSlots } from '@/core/time-slots'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { openTaskDayOf } from '@/lib/opentask-day'
import { notifiableUsers, type NotifiableUser } from '@/core/notifications/notifiable-users'
import { nagIntervalMinutes, userNagTiers, type NagTiers } from '@/core/notifications/nag-ladder'
import { claimNagSend, nagSendDue, SLOT_NAG_KEY } from '@/core/notifications/nag-sends'

const DEFAULT_RETENTION_DAYS = 30

/** Every priority the ladder has a rung for (Unset … Urgent). */
const PRIORITIES = [0, 1, 2, 3, 4]

interface UnfinishedSlot {
  slot: TimeSlot
  count: number
  promptCount: number
  /** The priority of each waiting item (`SlotWaiting.priorities`). */
  priorities: number[]
  start: number
}

/** The slot nag's interval for these waiting items: the shortest rung. */
function slotNagInterval(priorities: number[], tiers: NagTiers): number {
  return Math.min(...priorities.map((p) => nagIntervalMinutes('slot_nag', p, tiers)))
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

    unfinished.push({
      slot,
      count: inSlot.reminders,
      promptCount: inSlot.prompts,
      priorities: inSlot.priorities,
      start,
    })
  }

  return unfinished.sort((a, b) => b.start - a.start)
}

/**
 * The users who are getting a slot-open push on this exact minute — asked of
 * the sender's own decision function, so an EMPTY slot opening (which stays
 * silent) doesn't stand the nag down.
 */
function usersNotifiedThisMinute(now: Date): Set<number> {
  return new Set(pendingSlotNotifications(now).map((n) => n.userId))
}

/**
 * Minutes into the OpenTask day's calendar date, or null before the rollover
 * (the new OpenTask day hasn't started, so none of its slots has opened).
 */
function openedMinute(user: NotifiableUser, slots: TimeSlot[], now: Date): number | null {
  const local = DateTime.fromJSDate(now).setZone(user.timezone)
  if (!local.isValid) return null
  const rollover = rolloverTimeForUser(user.id)
  if (openTaskDayOf(now, user.timezone, rollover) !== local.toISODate()) return null
  return local.hour * 60 + local.minute
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
  /** The ladder's interval this nag is paced at (minutes). */
  intervalMinutes: number
}

/**
 * Every nag that should go out this minute — at most one per user.
 *
 * Read-only. `checkSlotNags` is what claims the send and delivers it.
 */
export function pendingSlotNags(now: Date = new Date()): PendingSlotNag[] {
  const pending: PendingSlotNag[] = []
  // Computed once rather than per user: it answers for every user at once.
  const alreadyNotified = usersNotifiedThisMinute(now)

  for (const user of notifiableUsers()) {
    // The cheap gates first: the clock against `nag_sends` at the FASTEST
    // rung (if even that isn't due, nothing waiting could be), then the
    // same-minute slot push. Only then the slots and their contents.
    const tiers = userNagTiers(user.id)
    if (!nagSendDue(user.id, SLOT_NAG_KEY, slotNagInterval(PRIORITIES, tiers), now)) continue
    if (alreadyNotified.has(user.id)) continue

    const slots = listTimeSlots(user.id)
    const minuteOfDay = openedMinute(user, slots, now)
    if (minuteOfDay === null) continue

    const unfinished = unfinishedOpenedSlots(user, slots, now, minuteOfDay)
    if (unfinished.length === 0) continue

    // The real pace: the shortest rung among everything this nag covers.
    const interval = slotNagInterval(
      unfinished.flatMap((u) => u.priorities),
      tiers,
    )
    if (!nagSendDue(user.id, SLOT_NAG_KEY, interval, now)) continue

    const [target] = unfinished
    pending.push({
      userId: user.id,
      slotId: target.slot.id,
      slotLabel: target.slot.label,
      count: target.count,
      promptCount: target.promptCount,
      otherSlots: unfinished.length - 1,
      intervalMinutes: interval,
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

/** Cron entry point — runs on the same minute tick as the slot reminders, after them. */
export async function checkSlotNags(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return

  try {
    const now = nowOverride ?? new Date()
    for (const nag of pendingSlotNags(now)) {
      // Claim before sending: a lost claim means this minute already sent.
      if (!claimNagSend(nag.userId, SLOT_NAG_KEY, nag.intervalMinutes, now)) continue

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
