/**
 * The Reminders surface's headline numbers (REDESIGN-V03 §6), pure so the
 * page header, the nav badge and the tests all read the same arithmetic.
 *
 * "Waiting so far" is Trent's definition (2026-09-04): every reminder still
 * waiting in a slot that has already started today, plus the un-slotted
 * "Anytime" ones. Later slots do not count yet. Nothing here is debt — a
 * reminder is never overdue — it is simply what the day has put in front of
 * him up to this moment.
 */
import { DateTime } from 'luxon'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

export interface SummaryGroup {
  slot: TimeSlot | null
  reminders: { id: number }[]
  considered: number
}

export interface RemindersSummary<G extends SummaryGroup = SummaryGroup> {
  /** Waiting in started slots + Anytime. The badge number. */
  waitingSoFar: number
  /** Waiting in slots that have not started yet. */
  waitingLater: number
  /** Considered today, all slots. */
  consideredTotal: number
  /** Waiting + considered, all slots — the day's denominator. */
  dayTotal: number
  /** Groups that count toward "so far", in slot order (Anytime last). */
  started: G[]
  /** Groups still ahead today, in slot order. */
  later: G[]
  /** The first later slot with something waiting — "all caught up until …". */
  nextUp: { slot: TimeSlot; waiting: number } | null
}

/** Has this slot's window begun, by the user's local clock? */
export function slotHasStarted(slot: TimeSlot | null, timezone: string, now: Date): boolean {
  if (!slot) return true
  const start = parseHHMM(slot.start_time)
  if (start === null) return true
  const local = DateTime.fromJSDate(now).setZone(timezone)
  return start <= local.hour * 60 + local.minute
}

export function summarizeReminders<G extends SummaryGroup>(
  groups: G[],
  timezone: string,
  now: Date = new Date(),
): RemindersSummary<G> {
  const started: G[] = []
  const later: G[] = []
  for (const g of groups) (slotHasStarted(g.slot, timezone, now) ? started : later).push(g)

  const count = (gs: G[]) => gs.reduce((n, g) => n + g.reminders.length, 0)
  const consideredTotal = groups.reduce((n, g) => n + g.considered, 0)
  const waitingSoFar = count(started)
  const waitingLater = count(later)
  const next = later.find((g) => g.slot && g.reminders.length > 0)

  return {
    waitingSoFar,
    waitingLater,
    consideredTotal,
    dayTotal: waitingSoFar + waitingLater + consideredTotal,
    started,
    later,
    nextUp: next && next.slot ? { slot: next.slot, waiting: next.reminders.length } : null,
  }
}
