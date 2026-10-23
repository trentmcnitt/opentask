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
 * ON DECK RIDES ALONG (2026-10-20, red-team B10/A12). A push that already
 * fires appends today's undone deck count ("3 reminders waiting · 5 on
 * deck"). Decks never make a slot notify (an empty slot stays silent), never
 * join the hourly nag or its "unfinished" test (`waitingBySlot` does not
 * count them), and never count toward `reminder_count`; the payload carries
 * them as `deck_count`. Slot pushes are APNs-only, so a user with no periods
 * or with Web Push only gets no count — accepted.
 *
 * ONE EXCEPTION, and it is deliberate: `slot-nags.ts` re-surfaces unfinished
 * slots at Trent's request (2026-09-21), paced since 2026-10-22 by the nag
 * ladder at the shortest rung among the waiting items' priorities. It still
 * writes nothing, still never marks anything overdue or badged, and still
 * never fires for a slot that has not opened. Read that module's header
 * before concluding the "no catch-up" claim above has been violated.
 *
 * NO SOUND (ruling 5, Trent 2026-10-22: sound only on overdue): the slot-open
 * push is a silent banner, like the nag (`buildSlotReminderNotification`).
 */

import { log } from '@/lib/logger'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import type { QuotaPrompt } from '@/lib/quota-prompts'
import { sendApnsSlotReminder, isApnsConfigured } from '@/core/notifications/apns'
import { getQuotaPromptsBySlot, promptWaiting } from '@/core/tasks/quota-prompts'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { listTimeSlots } from '@/core/time-slots'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { onDeckToday } from '@/core/tasks/deck'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { notifiableUsers } from '@/core/notifications/notifiable-users'
import { SLOT_NAG_KEY, stampNagSend } from '@/core/notifications/nag-sends'

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
  /**
   * The priority of every waiting item — each reminder's own, and each
   * prompt's quota task's — which the slot nag paces by (the shortest rung
   * wins, `slot-nags.ts`). One entry per item, reminders first.
   */
  priorities: number[]
}

/**
 * The priority of each quota behind a list of prompts, by task id. Read here
 * rather than carried on `QuotaPrompt`, which is the wire shape of
 * `GET /api/reminders` (and the native apps' contract): the slot nag is the
 * only reader, so the API stays as it is.
 */
function quotaPriorities(taskIds: number[]): Map<number, number> {
  if (taskIds.length === 0) return new Map()
  const unique = [...new Set(taskIds)]
  const rows = getDb()
    .prepare(`SELECT id, priority FROM tasks WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as { id: number; priority: number | null }[]
  return new Map(rows.map((r) => [r.id, r.priority ?? 0]))
}

/**
 * What is waiting in each of a user's slots right now, keyed by slot id
 * (`null` = the un-slotted group). The one place the notification cron counts
 * a slot, so the slot-open push and the nags cannot disagree about whether a
 * slot is finished.
 *
 * A prompt is waiting while it is neither considered nor done (`promptWaiting`,
 * the same test every client uses). Prompts come from the phase-1 computation
 * as-is — one quota query per call, and one more for the waiting prompts'
 * quota priorities. Called only for a user whose slot opens this minute, or
 * whose slot nag could be due by `nag_sends` at its fastest rung; never once
 * a minute for every user.
 */
export function waitingBySlot(
  userId: number,
  timezone: string,
  now: Date,
): Map<number | null, SlotWaiting> {
  const waitingPrompts = new Map<number | null, QuotaPrompt[]>()
  for (const [id, list] of getQuotaPromptsBySlot(userId, timezone, now)) {
    waitingPrompts.set(id, list.filter(promptWaiting))
  }
  const quotaPriority = quotaPriorities(
    [...waitingPrompts.values()].flatMap((list) => list.map((p) => p.task_id)),
  )
  const promptPriorities = (list: QuotaPrompt[]) =>
    list.map((p) => quotaPriority.get(p.task_id) ?? 0)

  const waiting = new Map<number | null, SlotWaiting>()
  for (const group of getRemindersBySlot(userId, timezone, now)) {
    const id = group.slot?.id ?? null
    const prompts = waitingPrompts.get(id) ?? []
    waiting.set(id, {
      reminders: group.reminders.length,
      prompts: prompts.length,
      priorities: [...group.reminders.map((t) => t.priority ?? 0), ...promptPriorities(prompts)],
    })
  }
  // `getRemindersBySlot` returns every slot plus the un-slotted group, so a
  // prompt's slot is always already there; this only guards a slot deleted
  // between the two reads.
  for (const [id, prompts] of waitingPrompts) {
    if (!waiting.has(id)) {
      waiting.set(id, {
        reminders: 0,
        prompts: prompts.length,
        priorities: promptPriorities(prompts),
      })
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
  /**
   * On deck (2026-10-20, B10/A12): the user's undone decks for today
   * (calendar day), appended to the body as "· N on deck". Never part of the
   * slot's emptiness test or `reminder_count`; 0 with the task queue off.
   */
  deckCount: number
}

/**
 * Every slot notification that should go out this minute.
 *
 * Split out from the sender so the decision (which slot, whose, how many) is
 * testable without APNs credentials — the same reason `checkOverdueTasks`
 * keeps its boundary math in a pure function.
 */
export function pendingSlotNotifications(now: Date = new Date()): PendingSlotNotification[] {
  const users = notifiableUsers()

  const pending: PendingSlotNotification[] = []

  for (const user of users) {
    const due = slotsDueNow(listTimeSlots(user.id), user.timezone, now)
    if (due.length === 0) continue

    const waiting = waitingBySlot(user.id, user.timezone, now)
    // Today's decks ride on a push that already fires (A12): read once per
    // user, and only for a user whose slot opens now.
    const deckCount = taskQueueEnabled() ? onDeckToday(user.id, user.timezone, now).length : 0

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
        deckCount,
      })
    }
  }

  return pending
}

/** Cron entry point — runs alongside the overdue check, every minute. */
export async function checkSlotReminders(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return

  try {
    const now = nowOverride ?? new Date()
    for (const item of pendingSlotNotifications(now)) {
      // The slot's own banner counts as the nag's last send (nag-sends.ts):
      // the nag then waits a full interval after it, instead of following it
      // a minute later.
      stampNagSend(item.userId, SLOT_NAG_KEY, now)
      await sendApnsSlotReminder(item.userId, {
        slotId: item.slotId,
        slotLabel: item.slotLabel,
        count: item.count,
        promptCount: item.promptCount,
        deckCount: item.deckCount,
      })
    }
  } catch (err) {
    log.error('notifications', 'Slot reminder checker error:', err)
  }
}
