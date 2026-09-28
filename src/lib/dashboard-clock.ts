/**
 * When the Tasks page's clock has to move — the pure half of `useDashboardNow`
 * (src/hooks/useDashboardNow.ts).
 *
 * Every overdue / today indicator on the dashboard (top-bar pills, the pinned
 * Overdue chip, the expanded date chips, the "↓ N overdue" jump button, the
 * tab title, the Overdue filter itself) is a function of the task list AND
 * "now". They used to read `new Date()` inside memos keyed on the task list
 * only, so a task crossing its due time while the page sat open changed
 * nothing until some unrelated data change: the row turned red (TaskList
 * re-renders often and reads the time unmemoized) but the pill, the chip and
 * the jump button never appeared (Trent, 2026-09-27 — two 7:30 PM tasks, "8m
 * ago" in red, no overdue pill).
 *
 * Rather than poll, the page holds one `now` and advances it at exactly the
 * instants an answer can change:
 *
 * - **`due_at + 1ms`** for every task that can be late (`hasDebtDueDate`):
 *   `isOverdue` is a STRICT `due < now`, so at `now === due_at` the task is
 *   not yet overdue. Waking at `due_at` itself would compute "not overdue",
 *   and — since the next candidate must be after `now` — skip the task until
 *   midnight. Fake timers (vitest, Playwright's clock) land exactly on the
 *   scheduled instant, so this is not hypothetical.
 * - **`due_at - 2h + 1ms`**: the Soon chip (`classifyTaskDueDate`) counts a
 *   task once it is due within two hours, same strict comparison.
 * - **the next local midnight** (`tomorrowStart`, DST-safe): Today, Tomorrow,
 *   This Week and Later all roll over there — and next week's start is itself
 *   a midnight.
 *
 * The result is always strictly after `now`, so a wake-up can never schedule
 * itself for the moment it is already at.
 */
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { hasDebtDueDate } from '@/lib/task-counts'
import type { Task } from '@/types'

/** The Soon date chip's window — must match `classifyTaskDueDate`. */
export const SOON_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * `setTimeout` stores its delay as a signed 32-bit int; anything larger fires
 * IMMEDIATELY (a ~24.8-day delay overflows). The next midnight is always
 * within a day, so this clamp only guards the arithmetic, but it is cheap.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

type ClockTask = Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>

/** The next instant, strictly after `now`, at which any dashboard date bucket can change. */
export function nextClockTick(tasks: ClockTask[], now: Date, timezone: string): Date {
  const nowMs = now.getTime()
  let next = getTimezoneDayBoundaries(timezone, now).tomorrowStart.getTime()
  for (const task of tasks) {
    if (!hasDebtDueDate(task)) continue
    const due = new Date(task.due_at).getTime()
    for (const candidate of [due + 1, due - SOON_WINDOW_MS + 1]) {
      if (candidate > nowMs && candidate < next) next = candidate
    }
  }
  return new Date(next)
}

/** Milliseconds to wait until `target`, clamped to what `setTimeout` accepts. */
export function clockTickDelay(target: Date, now: Date): number {
  return Math.min(Math.max(target.getTime() - now.getTime(), 0), MAX_TIMEOUT_MS)
}

/**
 * Whether the Overdue filter should switch itself off (Trent, 2026-09-27: "If
 * I'm in the overdue filter and I have no more overdue items left... I'd like
 * it to automatically deactivate"). Only on a TRANSITION — the count was
 * above zero and now is zero while the filter is on — so it never fights a
 * deliberate choice: a `?filter=overdue` deep link (or a tap) that lands with
 * nothing overdue observes 0 → 0 and leaves the filter on, showing "Showing 0
 * of N · Clear filter" until the user clears it. `prevCount` is null before
 * the first observation.
 */
export function shouldAutoClearOverdueFilter(
  prevCount: number | null,
  count: number,
  overdueSelected: boolean,
): boolean {
  return overdueSelected && prevCount !== null && prevCount > 0 && count === 0
}

/**
 * Whether two observations of the Overdue count describe the same VIEW (same
 * filter criteria, search, grouping — compared by identity, as memo deps
 * are). A count that dropped because the view changed is not "the overdue
 * tasks went away"; see `useAutoClearOverdueFilter`.
 */
export function sameViewScope(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((entry, i) => Object.is(entry, b[i]))
}
