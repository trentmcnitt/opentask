/**
 * Which TINT a lean row wears (Trent, 2026-10-28, today-mode round 6):
 *
 *   passed  a deadline that has passed — red; it wins over everything
 *   over    over target — blue, with the slate title
 *   soon    a target or deadline LATER TODAY (the OpenTask day), not yet
 *           over — a faint blue, title unchanged
 *
 * Pure: `LeanRow` draws them (`STATE_LOOK`). `isOverdue` is the list's own
 * answer for over target (the same one the card row reads).
 */
import { openTaskDayOf } from '@/lib/opentask-day'
import { isPastDeadline } from '@/lib/task-segments'

export type LeanRowState = 'passed' | 'over' | 'soon'

export function leanRowState(
  task: { due_at: string | null; deadline_at: string | null },
  isOverdue: boolean,
  timezone: string,
  dayStart: string,
  now: Date,
): LeanRowState | null {
  if (isPastDeadline(task.deadline_at, now)) return 'passed'
  if (isOverdue) return 'over'
  const today = openTaskDayOf(now, timezone, dayStart)
  const laterToday = (iso: string | null) => {
    if (!iso) return false
    const at = new Date(iso)
    return at > now && openTaskDayOf(at, timezone, dayStart) === today
  }
  return laterToday(task.due_at) || laterToday(task.deadline_at) ? 'soon' : null
}
