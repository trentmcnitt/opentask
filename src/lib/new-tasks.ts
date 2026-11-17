/**
 * NEW (2026-11-17, Trent, after mockups; it replaces the New PAGE of
 * 2026-11-10): a task that has not had its looks yet is drawn under a "New"
 * heading at the top of its own horizon segment, with Grow on its row. There
 * is no clock: a task stays New until it has been considered enough times
 * for its segment, or until New is ended for it. The five rules below, each
 * with its RULE block (the rules map); the seed for tasks older than the
 * columns is RULE NEW-SEED (src/core/db/index.ts).
 */
import { byPriorityRank } from '@/lib/priority'
import { setHorizonOrUnset, type HorizonValue } from '@/lib/task-segments'

/** The heading's word. */
export const NEW_HEADING_TITLE = 'New'

/**
 * How many considers end New, by the segment the task is in now. Days and
 * Weeks: two. Months and Eventually come round so rarely that one is enough
 * (Trent, 2026-11-17: "for time periods over 2 weeks, one consider is enough.
 * Otherwise, I'm going to get something that says a task is new even though
 * it's 2.5 months old").
 */
export const NEW_CONSIDERS: Record<HorizonValue, number> = {
  days: 2,
  weeks: 2,
  months: 1,
  eventually: 1,
}

/** The fields New reads. */
export interface NewTaskFields {
  horizon: string | null
  consider_count: number
  new_ended_at: string | null
}

/**
 * RULE NEW-WHO: A row of a horizon segment (Days, Weeks, Months, Eventually:
 *   an open one-off with no picked target, deck or deadline) is New while its
 *   consider count is under its segment's threshold (NEW_CONSIDERS: 2 in Days
 *   and Weeks, 1 in Months and Eventually, on the horizon it has now, unset
 *   read as Days) and New has not ended for it (NEW-ENDS). No clock and no
 *   day limit, however the task was made. A task outside the segments (a
 *   target, a deck, a deadline) is not shown as New; it keeps its count, and
 *   is New again if it comes back still under the threshold. On an Aged out
 *   day the task is in Aged out only, not under New.
 * Why: A new task is worth a look or two, and a pace, before it settles into
 *   its horizon's rhythm; counting looks, not days, means one never slips by
 *   unseen.
 * Ruling: Trent 2026-11-17: "New until considered twice with no day limit.
 *   Yes, I agree."; "for time periods over 2 weeks, one consider is enough."
 */
export function isNewRow(task: NewTaskFields): boolean {
  if (task.new_ended_at !== null) return false
  return task.consider_count < NEW_CONSIDERS[setHorizonOrUnset(task.horizon)]
}

/*
 * RULE NEW-ENDS: New ends for good (new_ended_at) on a Grow, on any change
 *   of the horizon after creation (the details, the select bar, the dot's
 *   menu, Process, the API; clearing it too), and at the seed for a task
 *   that existed before the columns (NEW-SEED). A horizon stated at
 *   creation, by the user or by enrichment reading the words, does not end
 *   it: the task starts New in that segment. Done ends it by leaving. An
 *   Undo of the change clears new_ended_at again; a put-back never does.
 * Why: Saying what pace a task has is the decision New asks for; once it is
 *   made the task is not new.
 * Ruling: Trent 2026-11-17 (the design: "hasn't been grown or had its
 *   horizon set by hand after creation"); "I don't like automatic settling."
 *
 * RULE NEW-COUNT: Every write of the considered stamp on a task adds 1 to
 *   consider_count: the circle, Consider all (each swept row once), the
 *   select bar's Consider, Keep and Grow, and Today or a deck from a segment
 *   row (they stamp it too); from any client. A put-back of a considered row
 *   takes 1 off (never below 0), and an Undo puts the old number back. Not
 *   today adds nothing.
 * Why: One number, written wherever the stamp is, so no surface can count a
 *   look the others miss.
 * Ruling: Trent 2026-11-17: "'Consider all' is fine. That counts as a
 *   'consider.'"
 *
 * RULE NEW-HEADING: A horizon segment with New rows waiting opens with the
 *   "New" heading over them, ordered by PRIO-RANK and then newest first; the
 *   segment's other rows follow in their own order. There is no New page and
 *   no "Carried over" line; no heading without a New row waiting. The row
 *   cap and "Show more" are the segment's, New rows first. New rows count
 *   in the segment's numbers and nudge like any row. On the wire a New row
 *   is in its horizon segment with `new: true`; `?new=1` is accepted and
 *   ignored, and no `new` segment is sent.
 * Why: A page of its own was one more place to tap through; the heading
 *   puts new tasks first where their pace is decided.
 * Ruling: Trent 2026-11-17: "Move `new` as a heading, and the new items come
 *   with the grow symbol."; "I don't think we need to have special
 *   consideration for the 5-row limit."
 *
 * RULE NEW-GROW: A New row has Grow, the Sprout with no word, where the
 *   on-deck-tomorrow control sits. A tap grows one step (Days → Weeks →
 *   Months → Eventually; unset → Weeks): the horizon is set, the task is
 *   considered, New ends, and the row leaves with "Grown to <horizon>" and
 *   an Undo. A hold or right-click offers every other horizon (Days too, for
 *   a row in Weeks). On Eventually a tap opens that menu: there is no step
 *   out. There is no "Grow all".
 * Why: The pace is the one decision a new task needs, so it is one tap on
 *   the row.
 * Ruling: Trent 2026-11-17: "I didn't think 'grow' needed the word next to
 *   it… just the symbol."; "we don't need to grow all".
 */
/** New rows' order under the heading: priority (PRIO-RANK), then newest. */
export function compareNewRows(
  a: { priority: number; created_at: string; id: number },
  b: { priority: number; created_at: string; id: number },
): number {
  return byPriorityRank(a, b) || Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
}
