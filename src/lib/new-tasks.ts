/**
 * NEW (2026-11-10, the design session's call; Trent: "Whatever you think is
 * best"): the task queue's one-off pass for the day after a task is written.
 * Prod data: 40% of one-offs are done the day they're written, 10% the next
 * day, 23% in days 2–6 — so the day after is when a fresh task is most worth
 * a look, before it settles into its horizon's rhythm.
 *
 * RULE N1 — WHO: an open one-off (not a reminder, quota or repeat — the
 * caller's `eligibleTasks` already), with no picked target, no deck and no
 * deadline, CREATED during the previous OpenTask day (rollover to rollover).
 * However it was made: typed, AI-added, from the desk.
 *
 * RULE N2 — ONE PLACE AT A TIME: on its New day it is in no horizon segment.
 *
 * RULE N3 — ONE PASS, NOT A BACKLOG: untouched by the next rollover, it drops
 * out of New into its horizon's rhythm. (Unlike the other segments' carry
 * over, on purpose.)
 *
 * RULE N4 — CONSIDER: it leaves New for its horizon, seen there — the
 * shared `last_considered_at` stamp counts for the horizon too. Listed today
 * as a handled row.
 *
 * RULE N5 — NOT TODAY: it comes back in New tomorrow, ONCE, as a CARRIED
 * row ("Carried over", below the fresh ones): made the day before yesterday
 * and deferred yesterday. Deferred again, it goes to its horizon's rhythm
 * the day after (N3).
 *
 * RULE N6 — Done, a target, a deck or a deadline: it leaves (N1).
 */
import { openTaskDayOf } from '@/lib/opentask-day'
import { shiftDay, type SegmentState } from '@/lib/task-segments'

/** The page's title, and the strip's word. */
export const NEW_PAGE_TITLE = 'New'
/** What the web adds to `REMINDERS_URL` to draw the page (`?new=1`). */
export const NEW_ROWS_QUERY = '&new=1'
/** The line over the rows back from yesterday's Not today (N5). */
export const CARRIED_OVER_TITLE = 'Carried over'

export interface NewTaskFields {
  created_at: string
  due_at: string | null
  deadline_at: string | null
  on_deck_day?: string | null
  rrule?: string | null
  is_reminder?: boolean
  done?: boolean
  last_considered_at?: string | null
  segment_deferred_at?: string | null
}

export interface NewTaskPlace {
  state: SegmentState
  /** N5: back from yesterday's Not today, under "Carried over". */
  carried: boolean
}

/** Where a task stands in New today, or null when it isn't there. Pure. */
export function newTaskPlace(
  task: NewTaskFields,
  timezone: string,
  now: Date,
  dayStart: string,
  /** New listed this task earlier today (the day roster): see "Carried" below. */
  listedInNewToday = false,
): NewTaskPlace | null {
  if (task.done || task.is_reminder || task.rrule) return null
  if (task.due_at || task.deadline_at || task.on_deck_day) return null
  const dayOf = (iso: string | null | undefined) =>
    iso ? openTaskDayOf(new Date(iso), timezone, dayStart) : null
  const today = openTaskDayOf(now, timezone, dayStart)
  const yesterday = shiftDay(today, -1, timezone)
  const made = dayOf(task.created_at)
  const fresh = made === yesterday
  // Carried (N5): made two days ago and deferred yesterday. Deferred AGAIN
  // today it stays in New today, shown deferred, and goes to its horizon's
  // rhythm the day after (2026-11-12; it used to jump to its horizon segment
  // the moment it was deferred, shrinking New's count). The second defer
  // overwrites yesterday's stamp, so "it was New's carried row today" is the
  // caller's to say (`listedInNewToday`, the day roster): a task made two days
  // ago that was NOT carried — left untouched yesterday, in its horizon
  // segment today — and is deferred there must stay there.
  const deferred = dayOf(task.segment_deferred_at)
  const carried =
    made === shiftDay(today, -2, timezone) &&
    (deferred === yesterday || (deferred === today && listedInNewToday))
  if (!fresh && !carried) return null
  // Seen on any other day (the made day, or a stamp a client wrote ahead):
  // seen already, so not on its pass.
  const seen = dayOf(task.last_considered_at)
  if (seen !== null && seen !== today) return null
  if (seen === today) return { state: 'considered', carried }
  if (dayOf(task.segment_deferred_at) === today) return { state: 'deferred', carried }
  return { state: 'waiting', carried }
}
