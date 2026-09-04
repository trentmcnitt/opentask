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
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { DateTime } from 'luxon'
import { sendApnsSlotReminder, isApnsConfigured } from '@/core/notifications/apns'
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

export interface PendingSlotNotification {
  userId: number
  slotId: number
  slotLabel: string
  count: number
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

    const groups = getRemindersBySlot(user.id, user.timezone, now)

    for (const slot of due) {
      const group = groups.find((g) => g.slot?.id === slot.id)
      // Silence when the slot is empty: an empty checklist is a notification
      // that costs attention and returns nothing.
      if (!group || group.reminders.length === 0) continue

      pending.push({
        userId: user.id,
        slotId: slot.id,
        slotLabel: slot.label,
        count: group.reminders.length,
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
      })
    }
  } catch (err) {
    log.error('notifications', 'Slot reminder checker error:', err)
  }
}
