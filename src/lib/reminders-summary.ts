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
import { CALENDAR_DAY_START, minutesIntoDay } from '@/lib/opentask-day'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { groupConsidered, groupWaiting, type QuotaPrompt } from '@/lib/quota-prompts'

export interface SummaryGroup {
  slot: TimeSlot | null
  reminders: { id: number }[]
  considered: number
  /**
   * Quota prompts (2026-09-24). They count exactly like reminders — waiting
   * until handled, then considered — through `groupWaiting` /
   * `groupConsidered`, so the headline, the badge and every bar agree.
   */
  prompts?: Pick<QuotaPrompt, 'considered' | 'done'>[]
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

/**
 * Has this slot's window begun today, by the user's local clock?
 *
 * "Today" is the day the server's roster is for: from `dayStart` (2026-10-23
 * — the user's "Day starts at" with the task queue on, `useReminderDayStart`;
 * midnight otherwise). With the day starting at 3:00, at 00:30 every slot of
 * the evening's day has started — the roster is still that day's — and a
 * 1:00 AM slot starts at the end of its day (`minutesIntoDay`).
 *
 * The un-slotted "Anytime" bucket has no start time and is always available,
 * so it counts as started — it is never "coming up later". So does a slot
 * whose time can't be read (a malformed start, or an invalid timezone).
 */
export function slotHasStarted(
  slot: TimeSlot | null,
  timezone: string,
  now: Date,
  dayStart: string = CALENDAR_DAY_START,
): boolean {
  if (!slot) return true
  const start = parseHHMM(slot.start_time)
  if (start === null) return true
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return true
  return minutesIntoDay(start, dayStart) <= minutesIntoDay(local.hour * 60 + local.minute, dayStart)
}

export function summarizeReminders<G extends SummaryGroup>(
  groups: G[],
  timezone: string,
  now: Date = new Date(),
  dayStart: string = CALENDAR_DAY_START,
): RemindersSummary<G> {
  const started: G[] = []
  const later: G[] = []
  for (const g of groups) {
    ;(slotHasStarted(g.slot, timezone, now, dayStart) ? started : later).push(g)
  }

  const count = (gs: G[]) => gs.reduce((n, g) => n + groupWaiting(g), 0)
  const consideredTotal = groups.reduce((n, g) => n + groupConsidered(g), 0)
  const waitingSoFar = count(started)
  const waitingLater = count(later)
  const next = later.find((g) => g.slot && groupWaiting(g) > 0)

  return {
    waitingSoFar,
    waitingLater,
    consideredTotal,
    dayTotal: waitingSoFar + waitingLater + consideredTotal,
    started,
    later,
    nextUp: next && next.slot ? { slot: next.slot, waiting: groupWaiting(next) } : null,
  }
}
