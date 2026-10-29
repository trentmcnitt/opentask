/**
 * CARD V2's LEFT EDGE (Trent, 2026-10-29, mockup "C1 · Separate cards"):
 *
 *   passed  a deadline that has passed — red; it wins
 *   over    over target — blue
 *   null    anything else: no edge (a target later today, a deadline's
 *           safety net and an undated row alike — "later today" got no edge)
 *
 * The edge is the card's only state mark: no tint on the body. Pure:
 * `LeanRow` (its `card-v2` look) draws it. `isOverdue` is the list's own
 * answer for over target, the one the lean and card rows read.
 */
import { isPastDeadline } from '@/lib/task-segments'

export type CardEdge = 'passed' | 'over'

export function cardEdge(
  task: { deadline_at: string | null },
  isOverdue: boolean,
  now: Date,
): CardEdge | null {
  if (isPastDeadline(task.deadline_at, now)) return 'passed'
  return isOverdue ? 'over' : null
}
