/**
 * Time-slot reminder notifications (REDESIGN-V03 §6)
 *
 * The SLOT notifies, not the item. A reminder never fires individually, is
 * never counted in overdue, and is never in the badge — so the only moment a
 * reminder can reach the user is when its slot opens, once, with a count.
 *
 * Timing is derived, not stored: a slot fires on the minute its `start_time`
 * matches the user's local wall clock. That makes the job stateless and
 * idempotent-by-clock — running the sweep twice in the same minute would send
 * twice, but the per-slot `collapseId` means the user still sees one banner,
 * and running it late (a missed tick) simply skips, which is correct for an
 * item class that has no debt.
 *
 * There is deliberately no roll-forward and no catch-up: a missed slot is a
 * missed thought, and the next occurrence arrives on its own (§6).
 *
 * QUOTA PROMPTS COUNT LIKE REMINDERS (quota reminders phase 3, 2026-09-24).
 * An unmet quota's prompt sits in a slot beside its reminders (see
 * `src/core/tasks/quota-prompts.ts`), and Trent's rule is that prompts behave
 * EXACTLY like reminders: a slot with only prompts still notifies, the body
 * counts both ("3 reminders · 2 quotas waiting"), and the slot stays
 * unfinished for the nags until every prompt is considered or done. Both off
 * switches (`users.quota_prompts_enabled`, `OPENTASK_QUOTA_PROMPTS=off`) live
 * inside `getQuotaPromptsBySlot`, so with either one off this module is back
 * to reminders only. Prompts never reach the badge or the overdue count.
 *
 * ONE EXCEPTION, and it is deliberate: `slot-nags.ts` re-surfaces an unfinished
 * slot on the hour, at most three times a day, at Trent's request (2026-09-21).
 * It still writes nothing, still never marks anything overdue or badged, and
 * still never fires for a slot that has not opened. Read that module's header
 * before concluding the "no catch-up" claim above has been violated.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { DateTime } from 'luxon'
import { sendApnsSlotReminder, isApnsConfigured } from '@/core/notifications/apns'
import { getQuotaPromptsBySlot, promptWaiting } from '@/core/tasks/quota-prompts'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { listTimeSlots } from '@/core/time-slots'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

interface NotifiableUser {
  id: number
  timezone: string
}

/** The slots whose start time is the current local minute for this user. */
export function slotsDueNow(slots: TimeSlot[], timezone: string, now: Date): TimeSlot[] {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return []
  const minuteOfDay = local.hour * 60 + local.minute

  return slots.filter((slot) => parseHHMM(slot.start_time) === minuteOfDay)
}

/** What is still waiting in one slot: reminders, and quota prompts. */
export interface SlotWaiting {
  reminders: number
  prompts: number
}

/**
 * What is waiting in each of a user's slots right now, keyed by slot id
 * (`null` = the un-slotted group). The one place the notification cron counts
 * a slot, so the slot-open push and the nags cannot disagree about whether a
 * slot is finished.
 *
 * A prompt is waiting while it is neither considered nor done (`promptWaiting`,
 * the same test every client uses). Prompts come from the phase-1 computation
 * as-is — one quota query per call. Called only for a user whose slot opens
 * this minute, or who is awake at the top of the hour with nags left to spend
 * today; never once a minute for every user.
 */
export function waitingBySlot(
  userId: number,
  timezone: string,
  now: Date,
): Map<number | null, SlotWaiting> {
  const prompts = getQuotaPromptsBySlot(userId, timezone, now)
  const waiting = new Map<number | null, SlotWaiting>()

  for (const group of getRemindersBySlot(userId, timezone, now)) {
    const id = group.slot?.id ?? null
    waiting.set(id, {
      reminders: group.reminders.length,
      prompts: (prompts.get(id) ?? []).filter(promptWaiting).length,
    })
  }
  // `getRemindersBySlot` returns every slot plus the un-slotted group, so a
  // prompt's slot is always already there; this only guards a slot deleted
  // between the two reads.
  for (const [id, list] of prompts) {
    if (!waiting.has(id)) {
      waiting.set(id, { reminders: 0, prompts: list.filter(promptWaiting).length })
    }
  }
  return waiting
}

export interface PendingSlotNotification {
  userId: number
  slotId: number
  slotLabel: string
  /** Reminders waiting in the slot. */
  count: number
  /** Quota prompts waiting in the slot. */
  promptCount: number
}

/**
 * Every slot notification that should go out this minute.
 *
 * Split out from the sender so the decision (which slot, whose, how many) is
 * testable without APNs credentials — the same reason `checkOverdueTasks`
 * keeps its boundary math in a pure function.
 */
export function pendingSlotNotifications(now: Date = new Date()): PendingSlotNotification[] {
  const users = getDb()
    .prepare('SELECT id, timezone FROM users WHERE notifications_enabled = 1')
    .all() as NotifiableUser[]

  const pending: PendingSlotNotification[] = []

  for (const user of users) {
    const due = slotsDueNow(listTimeSlots(user.id), user.timezone, now)
    if (due.length === 0) continue

    const waiting = waitingBySlot(user.id, user.timezone, now)

    for (const slot of due) {
      const inSlot = waiting.get(slot.id)
      // Silence when the slot is empty: an empty checklist is a notification
      // that costs attention and returns nothing. A slot with only quota
      // prompts is NOT empty — it notifies like any other.
      if (!inSlot || inSlot.reminders + inSlot.prompts === 0) continue

      pending.push({
        userId: user.id,
        slotId: slot.id,
        slotLabel: slot.label,
        count: inSlot.reminders,
        promptCount: inSlot.prompts,
      })
    }
  }

  return pending
}

/** Cron entry point — runs alongside the overdue check, every minute. */
export async function checkSlotReminders(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return

  try {
    for (const item of pendingSlotNotifications(nowOverride ?? new Date())) {
      await sendApnsSlotReminder(item.userId, {
        slotId: item.slotId,
        slotLabel: item.slotLabel,
        count: item.count,
        promptCount: item.promptCount,
      })
    }
  } catch (err) {
    log.error('notifications', 'Slot reminder checker error:', err)
  }
}
