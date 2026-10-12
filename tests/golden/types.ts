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
 *   quiet | days | weeks | months | eventually | upcoming | over | done
 *   + "N×" (attempts, while the task has a target) + age (">1 mo")
 *   + "→remove" / "→auto" (the 3× offer).
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
}
