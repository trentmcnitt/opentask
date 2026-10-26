/**
 * THE MINUTE TICK — every cron sender in one coordinated pass (tick.ts).
 *
 * The order is the senders' old order on the cron, and it matters:
 *  1. the overdue checker;
 *  2. the slot-open push — its claim stamps the slot nag's clock;
 *  3. the slot nag — AFTER the slot-open push on purpose: a slot opening on
 *     this exact minute sends its own push, and the nag stands down for that
 *     minute rather than putting a second banner beside it;
 *  4. the named reminder pushes (Medium+ reminders, reminder-nags.ts) — their
 *     own `nag_sends` rows, so where they sit only breaks lead-order ties;
 *  5. the deadlines-page nag.
 *
 * `scripts/count-pushes.ts` plans this same list without delivering.
 */

import { OVERDUE_SOURCE } from '@/core/notifications/overdue-checker'
import { SLOT_REMINDER_SOURCE } from '@/core/notifications/slot-reminders'
import { SLOT_NAG_SOURCE } from '@/core/notifications/slot-nags'
import { REMINDER_NAG_SOURCE } from '@/core/notifications/reminder-nags'
import { DEADLINE_NAG_SOURCE } from '@/core/notifications/deadline-nags'
import { runTick, type TickSource } from '@/core/notifications/tick'

export const MINUTE_TICK_SOURCES: readonly TickSource[] = [
  OVERDUE_SOURCE,
  SLOT_REMINDER_SOURCE,
  SLOT_NAG_SOURCE,
  REMINDER_NAG_SOURCE,
  DEADLINE_NAG_SOURCE,
]

/** The notification cron's minute: plan every source, one alert per user, deliver. */
export async function runMinuteTick(nowOverride?: Date): Promise<void> {
  await runTick([...MINUTE_TICK_SOURCES], nowOverride ?? new Date())
}
