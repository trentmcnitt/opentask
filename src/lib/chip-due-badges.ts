/**
 * The dashboard filter chips' "due today" / "overdue" badges (feat/chip-due-badges,
 * Trent 2026-09-23, replacing the teal completion fill from §ITEM 2 — see
 * DEV_LOG for why: tasks leave the list once they're done, so a fill that
 * counts up toward "everything due today is done" never actually filled).
 *
 * Every project chip, and the "Today" time chip, show a small indigo pill
 * (still due later today) and/or a solid red pill (overdue) after their
 * muted total. This is the one place that decides which pill — if either —
 * a single task belongs to, so `ProjectFilterBar` and `DueDateFilterBar`
 * can't drift into disagreeing definitions of "overdue".
 *
 * Deliberately NOT a new definition of overdue: it's the same `due_at < now`
 * comparison `classifyTaskDueDate` (DueDateFilterBar.tsx) and `countTasks`
 * (task-counts.ts) already use, and the same `getTimezoneDayBoundaries` day
 * window. The one difference from `classifyTaskDueDate` is that its buckets
 * are independent (a task due earlier today is BOTH "overdue" and "today"),
 * while a badge is exclusive — the pill answers "is this one still coming,
 * or is it already late", not "is this in today's calendar box", so a task
 * due earlier today reads as overdue only.
 *
 * Callers are responsible for passing an already-faceted task list (see
 * `applyTaskFilters`'s `skipGroup`) and for excluding reminders/quotas —
 * this module doesn't re-derive either, so there's exactly one place (the
 * caller's own task list) that decides what population a chip counts over.
 */
import type { Task } from '@/types'
import type { DayBoundaries } from '@/lib/format-date'

export type ChipDueBadge = 'due_today' | 'overdue' | null

/** Only the two edges of "today" matter here — the rest of `DayBoundaries` is irrelevant. */
type TodayBoundaries = Pick<DayBoundaries, 'todayStart' | 'tomorrowStart'>

/**
 * Classifies one task's due date into exactly one badge, or none.
 * - `overdue`: has a due date in the past (relative to `now`), regardless of which day.
 * - `due_today`: has a due date later today (in `boundaries`' timezone) that hasn't arrived yet.
 * - `null`: no due date, or due later than today.
 */
export function classifyChipDueBadge(
  task: Pick<Task, 'due_at'>,
  now: Date,
  boundaries: TodayBoundaries,
): ChipDueBadge {
  if (!task.due_at) return null
  const due = new Date(task.due_at)
  if (due < now) return 'overdue'
  if (due >= boundaries.todayStart && due < boundaries.tomorrowStart) return 'due_today'
  return null
}

export interface ChipDueCounts {
  dueToday: number
  overdue: number
}

/** Tallies `classifyChipDueBadge` over a task list — the chip pills' actual numbers. */
export function countChipDueBadges(
  tasks: Pick<Task, 'due_at'>[],
  now: Date,
  boundaries: TodayBoundaries,
): ChipDueCounts {
  const counts: ChipDueCounts = { dueToday: 0, overdue: 0 }
  for (const task of tasks) {
    const badge = classifyChipDueBadge(task, now, boundaries)
    if (badge === 'due_today') counts.dueToday++
    else if (badge === 'overdue') counts.overdue++
  }
  return counts
}
