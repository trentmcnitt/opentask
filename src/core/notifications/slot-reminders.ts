/**
 * Time-slot reminder notifications (REDESIGN-V03 §6)
 *
 * The SLOT notifies, not the item — for None and Low reminders. A reminder is
 * never counted in overdue and never in the badge, so for those the only
 * moment it reaches the user is when its slot opens, once, with a count.
 *
 * MEDIUM AND ABOVE ARE PUSHED BY NAME (2026-10-26, Trent; reminder-nags.ts):
 * their own banner at the period's open, repeating on the slot-nag rung
 * until considered or the day ends. They are left out of `waitingBySlot`, so
 * they are never in this push's count or the slot nag's, and a period with
 * only Medium+ reminders waiting sends neither. Priority alone decides
 * (`getsNamedPush`, reminder-nag-rule.ts): a reminder's own Nag value is
 * ignored (Trent, 2026-10-26).
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
 * Since Push PR 4 (2026-10-26) that is None and Low prompts only: a prompt
 * whose quota is Medium or above is pushed by name (prompt-nags.ts), exactly
 * like a Medium+ reminder, and left out of `waitingBySlot`.
 *
 * ON DECK RIDES ALONG (2026-10-20, red-team B10/A12). A push that already
 * fires appends today's undone deck count ("3 reminders waiting · 5 on
 * deck"). Decks never make a slot notify (an empty slot stays silent), never
 * join the slot nag or its "unfinished" test (`waitingBySlot` does not
 * count them), and never count toward `reminder_count`; the payload carries
 * them as `deck_count`. Slot pushes are APNs-only, so a user with no periods
 * or with Web Push only gets no count — accepted.
 *
 * ONE EXCEPTION, and it is deliberate: `slot-nags.ts` re-surfaces unfinished
 * slots at Trent's request (2026-09-21), paced since 2026-10-22 by the nag
 * ladder (the waiting items' rungs, on clock marks since 2026-10-26). It still
 * writes nothing, still never marks anything overdue or badged, and still
 * never fires for a slot that has not opened. Read that module's header
 * before concluding the "no catch-up" claim above has been violated.
 *
 * NO SOUND (ruling 5, Trent 2026-10-22: sound only on overdue): the slot-open
 * push is a silent banner, like the nag (`buildSlotReminderNotification`).
 */

import { DateTime } from 'luxon'
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
import { runTick, type Channels, type SourcePlan, type TickSource } from '@/core/notifications/tick'
import { getsNamedPush, promptGetsNamedPush } from '@/core/notifications/reminder-nag-rule'

/** The slots whose start time is the current local minute for this user. */
export function slotsDueNow(slots: TimeSlot[], timezone: string, now: Date): TimeSlot[] {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return []
  const minuteOfDay = local.hour * 60 + local.minute

  return slots.filter((slot) => parseHHMM(slot.start_time) === minuteOfDay)
}

/** What is still waiting in one slot: reminders, and quota prompts. */
export interface SlotWaiting {
  /**
   * None and Low reminders only (2026-10-26): Medium and above are pushed
   * by name (reminder-nags.ts) and never counted here — so a period with
   * only Medium+ reminders waiting sends no period push and no period nag.
   */
  reminders: number
  /** None and Low prompts only (by their quota's priority): Medium+ ones are pushed by name (prompt-nags.ts). */
  prompts: number
  /**
   * The priority of every waiting item it counts — each None/Low reminder's
   * own, and each None/Low prompt's quota's — which the slot nag paces by
   * (the rung whose mark comes first, `slot-nags.ts`). One entry per item,
   * reminders first.
   */
  priorities: number[]
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
 * whose slot nag could be due by `nag_sends` (any rung's mark); never once
 * a minute for every user.
 */
export function waitingBySlot(
  userId: number,
  timezone: string,
  now: Date,
): Map<number | null, SlotWaiting> {
  // Prompts with their own named push (Medium+ quotas, prompt-nags.ts) are
  // not the period's: neither counted nor pacing the nag. A prompt carries
  // its quota's priority (`QuotaPrompt.priority`).
  const waitingPrompts = new Map<number | null, QuotaPrompt[]>()
  for (const [id, list] of getQuotaPromptsBySlot(userId, timezone, now)) {
    waitingPrompts.set(
      id,
      list.filter((p) => promptWaiting(p) && !promptGetsNamedPush(p)),
    )
  }
  const promptPriorities = (list: QuotaPrompt[]) => list.map((p) => p.priority ?? 0)

  const waiting = new Map<number | null, SlotWaiting>()
  for (const group of getRemindersBySlot(userId, timezone, now)) {
    const id = group.slot?.id ?? null
    const prompts = waitingPrompts.get(id) ?? []
    // Reminders with their own named push (reminder-nag-rule.ts) neither
    // count in the period's push or nag nor pace the nag.
    const counted = group.reminders.filter((t) => !getsNamedPush(t))
    waiting.set(id, {
      reminders: counted.length,
      prompts: prompts.length,
      priorities: [...counted.map((t) => t.priority ?? 0), ...promptPriorities(prompts)],
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

/**
 * This minute's slot-open pushes as tick sends (tick.ts), APNs only. Kind
 * `period`; a push speaks for its slot's waiting reminders and prompts.
 */
export function planSlotReminderSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.apns) return { sends: [] }
  return {
    sends: pendingSlotNotifications(now).map((item) => ({
      userId: item.userId,
      kind: 'period',
      items: item.count + item.promptCount,
      // A silent banner (ruling 5): never leads a minute something sounds in.
      silent: true,
      // The slot's own banner counts as the nag's last send (nag-sends.ts):
      // the nag then waits for the mark after it, instead of following it a
      // minute later. Always claimed: a slot opening is not deduped.
      claim: () => {
        stampNagSend(item.userId, SLOT_NAG_KEY, now)
        return true
      },
      deliver: (delivery) =>
        sendApnsSlotReminder(item.userId, {
          slotId: item.slotId,
          slotLabel: item.slotLabel,
          count: item.count,
          promptCount: item.promptCount,
          deckCount: item.deckCount,
          suffix: delivery.suffix ?? undefined,
          passive: delivery.passive,
        }),
    })),
  }
}

/** The slot-open push as one of the minute tick's sources. */
export const SLOT_REMINDER_SOURCE: TickSource = {
  name: 'Slot reminder checker',
  minuteKey: 'tick-slot-open',
  plan: planSlotReminderSends,
}

/** The slot-open push on its own (tests): one tick with this source alone. */
export async function checkSlotReminders(nowOverride?: Date): Promise<void> {
  if (!isApnsConfigured()) return
  await runTick([SLOT_REMINDER_SOURCE], nowOverride ?? new Date())
}
