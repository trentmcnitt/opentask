/**
 * Process — the pure rules (2026-10-10 task model, spec §5). The server reads
 * the rows (`src/core/tasks/process.ts`, `GET /api/process`); this decides
 * what Process asks about each one, with no AI involved, so Process works with
 * AI off.
 *
 * FOUR STEPS, in the order the modal walks them:
 *
 * 1. Inbox — open one-off tasks still in the Inbox project, to sort into a
 *    project (the AI may highlight one; the user picks).
 * 2. Possible duplicates — AI only; not computed here.
 * 3. Horizon growth — a task "long past its horizon" is asked whether its
 *    horizon should grow one step. Trent (10-10): "If I said weeks and it's
 *    been months, it asks, 'Is this a months-horizon item?' … after 6 months,
 *    'Do you want this to just be an eventual thing?'" Horizons never grow on
 *    their own; this only ASKS, and the modal batches the asks with a default.
 * 4. Old targets — over-target tasks whose target is STALE_TARGET_DAYS old or
 *    more, offered for one-tap target removal (spec §4). A task with a
 *    deadline is listed apart and never pre-checked (amendment 7): a client
 *    deadline's nag is not something to stop quietly.
 *
 * ONE PLACE PER TASK. A task with a target of its own decides nothing by its
 * horizon (2026-10-12, spec §1: a target makes a task quiet until its date;
 * it is in Upcoming before it, over target after) — so growth never asks
 * about it. A task whose target has arrived is over target: step 4's
 * territory (and the dashboard's). Growth asks only about tasks with no
 * target of their own — a deadline-only task too, unless its deadline is
 * close enough to steer its horizon — and the two steps never show the same
 * task.
 */

import {
  HORIZON_ORDER,
  STALE_TARGET_DAYS,
  UNSET_HORIZON,
  deadlineHorizon,
  effectiveTargetAt,
  targetAgeDays,
  targetIsToday,
  type HorizonValue,
  type TargetContext,
} from '@/lib/task-segments'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a task may sit on its horizon before Process asks to grow it, by
 * the horizon it is on. Measured from `horizon_set_at` (the last time the
 * horizon was set or re-affirmed), else from creation. Unset counts as weeks.
 * - days → 14 days ("weeks?")
 * - weeks / unset → 60 days ("months?")
 * - months → 180 days ("eventually?" — Trent's "after 6 months")
 * Placeholders Trent may tune.
 */
export const GROWTH_ASK_DAYS: Record<Exclude<HorizonValue, 'eventually'>, number> = {
  days: 14,
  weeks: 60,
  months: 180,
}

/**
 * From this priority up (P2 Medium), a growth ask also offers "do it" (target
 * today) and "raise priority" beside "grow" (Trent, 10-10: "For medium
 * priority and up, Process's 'grow the horizon?' question also offers 'do it /
 * raise priority.'").
 */
export const GROWTH_ACT_MIN_PRIORITY = 2

/** The fields the Process rules read. */
export interface ProcessTaskFields {
  id: number
  priority: number
  horizon: string | null
  horizon_set_at: string | null
  created_at: string
  due_at: string | null
  original_due_at: string | null
  deadline_at: string | null
  deadline_nag_off?: boolean
  rrule?: string | null
}

export interface GrowthAsk {
  /** The set horizon, or null when unset (read as weeks, never reported as set). */
  from: HorizonValue | null
  to: HorizonValue
  /** Whole days on the current horizon. */
  days_on_horizon: number
  /** P2+: offer "do it" and "raise priority" beside "grow". */
  can_act: boolean
}

function setHorizon(value: string | null): HorizonValue | null {
  return (HORIZON_ORDER as readonly string[]).includes(value ?? '') ? (value as HorizonValue) : null
}

/**
 * Whether Process should ask to grow this task's horizon, and to what. Reads
 * the SET horizon, not the effective one: a deadline pulling the horizon in is
 * not the user's pace, so "grow it?" would answer the wrong question. For the
 * same reason a task whose deadline is close enough to steer its horizon
 * (`deadlineHorizon`, within 90 days or past) is never asked — growing the set
 * horizon would change nothing it shows, and the deadline already decides.
 */
export function growthAsk(
  task: ProcessTaskFields,
  timezone: string,
  now: Date,
  ctx: TargetContext | null = null,
): GrowthAsk | null {
  // A target of its own: quiet until its date, its horizon shown nowhere
  // (spec §1, 2026-10-12) — "grow it?" would ask about a hidden setting.
  if (task.due_at !== null) return null
  if (targetIsToday(effectiveTargetAt(task, ctx, now), timezone, now)) return null
  if (deadlineHorizon(task.deadline_at, now) !== null) return null
  const from = setHorizon(task.horizon)
  const on = from ?? UNSET_HORIZON
  if (on === 'eventually') return null
  const since = Date.parse(task.horizon_set_at ?? task.created_at)
  const days = Math.floor((now.getTime() - since) / DAY_MS)
  if (days < GROWTH_ASK_DAYS[on]) return null
  return {
    from,
    to: HORIZON_ORDER[HORIZON_ORDER.indexOf(on) + 1],
    days_on_horizon: days,
    can_act: task.priority >= GROWTH_ACT_MIN_PRIORITY,
  }
}

/** Whole days the task's target is past (see `targetAgeDays`) when it is stale, else null. */
export function staleTargetAge(
  task: ProcessTaskFields,
  timezone: string,
  now: Date,
  ctx: TargetContext | null = null,
): number | null {
  const age = targetAgeDays(task, timezone, now, ctx)
  return age !== null && age >= STALE_TARGET_DAYS ? age : null
}

export interface ProcessPlan<T extends ProcessTaskFields> {
  growth: { task: T; ask: GrowthAsk }[]
  staleTargets: { task: T; age: number }[]
  staleTargetsWithDeadline: { task: T; age: number }[]
}

/**
 * Sort the user's segment-eligible tasks (open, one-off, own, not a reminder
 * or quota) into Process's rule-based steps. Growth: longest on its horizon
 * first. Old targets: oldest first. Ties by id, so the lists hold still.
 */
export function planProcess<T extends ProcessTaskFields>(
  tasks: T[],
  timezone: string,
  now: Date,
  /** The user's target context (`getTargetContext`), so an implied deadline target lands where the dashboard puts it. */
  ctx: TargetContext | null = null,
): ProcessPlan<T> {
  const plan: ProcessPlan<T> = { growth: [], staleTargets: [], staleTargetsWithDeadline: [] }
  for (const task of tasks) {
    const age = staleTargetAge(task, timezone, now, ctx)
    if (age !== null) {
      ;(task.deadline_at ? plan.staleTargetsWithDeadline : plan.staleTargets).push({ task, age })
      continue
    }
    const ask = growthAsk(task, timezone, now, ctx)
    if (ask) plan.growth.push({ task, ask })
  }
  plan.growth.sort((a, b) => b.ask.days_on_horizon - a.ask.days_on_horizon || a.task.id - b.task.id)
  const byAge = (a: { task: T; age: number }, b: { task: T; age: number }) =>
    b.age - a.age || a.task.id - b.task.id
  plan.staleTargets.sort(byAge)
  plan.staleTargetsWithDeadline.sort(byAge)
  return plan
}
