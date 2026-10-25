/**
 * The golden scenario format (spec "Testing and evaluation", 2026-10-12).
 *
 * A scenario is a dated, day-by-day expected timeline: tasks created at given
 * local times, scripted steps, a policy for what the user does each day, and
 * for each task what shows on each local day. The runner
 * (`tests/behavioral/golden.test.ts`) plays it through the day simulator
 * (`src/core/sim/day-simulator.ts`) against the real core and compares EVERY
 * day of the window, from the day each task is created.
 *
 * A day's line is the simulator's `dayLine`: the place, then the badges —
 *   quiet | days | weeks | months | eventually | tomorrow | later | over | done
 *   (Upcoming's line is its SECTION since 2026-10-25 — `counts` still say
 *   `upcoming`, both sections)
 *   + "N×" (attempts, while the task has a target) + age (">1 mo")
 *   + "→remove" (the 3× offer; "→auto" until 2026-10-22).
 * Unlisted days are "quiet". Keys are a date ("2026-10-17") or an inclusive
 * range ("2026-10-28..2026-10-31").
 *
 * All America/Chicago (the test user's zone). The day is read at 21:00 local
 * unless `at` says otherwise, AFTER the day's scripted steps and BEFORE the
 * policy acts — so a row the policy considers still shows that day.
 */
import type { SimContext, SimPolicy } from '@/core/sim/day-simulator'

export interface GoldenTask {
  name: string
  /** Local creation time. */
  created: string
  /** The create body (`createTask` input): title, target_at/due_at, rrule, deadline_at… */
  input: Record<string, unknown>
  /** Run right after creation — e.g. backdate `target_set_at` (a past completion). */
  after?: (id: number, ctx: SimContext) => void
}

export interface GoldenScenario {
  id: string
  title: string
  /** Where the case comes from: a spec table row, a 10-12 case, a v7 row. */
  source: string
  /** First local day of the window. */
  from: string
  /** Last local day of the window (inclusive). */
  to: string
  at?: string
  policy: SimPolicy[]
  tasks: GoldenTask[]
  /** Scripted steps at local times (moves, early dones, extra checks). */
  events?: { at: string; run: (ctx: SimContext) => void }[]
  expect: Record<string, Record<string, string>>
  /** Per-day counts to check (a subset of the simulator's `counts`). */
  counts?: Record<string, Record<string, number>>
  /**
   * The task queue ON (task-queue PR 2): the runner sets OPENTASK_TASK_QUEUE,
   * gives the user these periods (default 06:30 / 12:00 / 20:30), morning
   * time (default 08:30) and "Day starts at" (`dayStart`, default 06:30 —
   * pinned 2026-10-24, when the unset default moved from the first period's
   * start to 3:00 AM; `null` leaves it unset, the 3:00 default), stamps
   * `last_rollover_date` to the day before `from`, and runs the rollover at
   * each day's rollover moment — or at `late[date]` (HH:mm), a missed run
   * caught up. A queued task's line says "queued" after its place.
   */
  queue?: {
    periods?: string[]
    morning?: string
    dayStart?: string | null
    late?: Record<string, string>
  }
}
