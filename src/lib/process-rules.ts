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
 * 4. Old targets — tasks with ATTEMPTS_OFFER_REMOVE (3) attempts or more (spec
 *    §7: "At 3×, Process … offer 'remove target?'"), offered for one-tap
 *    target removal. Offered, never automatic. A task with a
 *    deadline is listed apart and never pre-checked (amendment 7): its target
 *    goes back to the deadline's automatic one (§8.3, "Back to auto"), and a
 *    task already on its automatic target is not listed at all.
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
  ATTEMPTS_OFFER_REMOVE,
  HORIZON_ORDER,
  UNSET_HORIZON,
  deadlineHorizon,
  hasPickedTarget,
  pastAgeThreshold,
  targetIsToday,
  type HorizonValue,
} from '@/lib/task-segments'

const DAY_MS = 24 * 60 * 60 * 1000

/*
 * WHEN GROWTH ASKS (spec §7, rulings Q6/Q7, 2026-10-12): past the SAME
 * per-horizon threshold as the age badge (`AGE_THRESHOLDS` in
 * task-segments.ts — one set): days > 7 days ("weeks?"), weeks or unset > 1
 * month ("months?"), months > 1 quarter ("eventually?"). Measured from the
 * latest of the horizon's own clock (`horizon_set_at`, else creation) and the
 * last "keep" (`growth_kept_at`): keeping a horizon asks again only after
 * another threshold period. The badge still shows creation age.
 */

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
  /** The last Process "keep" (ruling Q7): growth asks again a threshold after it. */
  growth_kept_at?: string | null
  /** Effective attempts (§7) — the old-targets step lists 3× and up. */
  attempts?: number
  target_auto?: boolean
  rrule?: string | null
  /** On deck (2026-10-20): a deck is a plan, like a picked target — no growth ask (B7). */
  on_deck_day?: string | null
}

export interface GrowthAsk {
  /** The set horizon, or null when unset (read as weeks, never reported as set). */
  from: HorizonValue | null
  to: HorizonValue
  /** Whole days on the current horizon (since `horizon_set_at`, else creation). */
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
  /** The owner's day boundary (`dayBoundaryForUser`): "targeted today" is the OpenTask day. */
  dayStart: string,
): GrowthAsk | null {
  // A target the user picked: quiet until its date, its horizon shown nowhere
  // (spec §1, 2026-10-12) — "grow it?" would ask about a hidden setting.
  if (hasPickedTarget(task)) return null
  // On deck (2026-10-20, B7): the same — a plan for a day, horizon shown nowhere.
  if (task.on_deck_day) return null
  if (targetIsToday(task.due_at, timezone, now, dayStart)) return null
  if (deadlineHorizon(task.deadline_at, now) !== null) return null
  const from = setHorizon(task.horizon)
  const on = from ?? UNSET_HORIZON
  if (on === 'eventually') return null
  const onSince = task.horizon_set_at ?? task.created_at
  const clock =
    task.growth_kept_at && Date.parse(task.growth_kept_at) > Date.parse(onSince)
      ? task.growth_kept_at
      : onSince
  if (!pastAgeThreshold(on, clock, now, timezone)) return null
  const days = Math.floor((now.getTime() - Date.parse(onSince)) / DAY_MS)
  return {
    from,
    to: HORIZON_ORDER[HORIZON_ORDER.indexOf(on) + 1],
    days_on_horizon: days,
    can_act: task.priority >= GROWTH_ACT_MIN_PRIORITY,
  }
}

/**
 * The task's attempts when Process should offer to remove its target: over
 * target now, at 3× or more (`ATTEMPTS_OFFER_REMOVE`). Else null. (The row
 * offers it at 3× whatever the target's date — `attemptsOffer`; Process, like
 * its old "targets 7+ days old" step, works through what is over target.)
 */
export function staleTargetAttempts(task: ProcessTaskFields, now: Date): number | null {
  const attempts = task.attempts ?? 0
  if (task.due_at === null || Date.parse(task.due_at) > now.getTime()) return null
  return attempts >= ATTEMPTS_OFFER_REMOVE ? attempts : null
}

export interface ProcessPlan<T extends ProcessTaskFields> {
  growth: { task: T; ask: GrowthAsk }[]
  staleTargets: { task: T; attempts: number }[]
  staleTargetsWithDeadline: { task: T; attempts: number }[]
}

/**
 * Sort the user's segment-eligible tasks (open, one-off, own, not a reminder
 * or quota) into Process's rule-based steps. Growth: longest on its horizon
 * first. Old targets: most attempts first. Ties by id, so the lists hold still.
 */
export function planProcess<T extends ProcessTaskFields>(
  tasks: T[],
  timezone: string,
  now: Date,
  /** The owner's day boundary (`dayBoundaryForUser`). */
  dayStart: string,
): ProcessPlan<T> {
  const plan: ProcessPlan<T> = { growth: [], staleTargets: [], staleTargetsWithDeadline: [] }
  for (const task of tasks) {
    // A deadline's AUTOMATIC target (§8) is not offered: there is nothing to
    // remove — clearing it puts the same automatic target back — and the
    // deadline is what it nags for.
    const attempts = task.target_auto ? null : staleTargetAttempts(task, now)
    if (attempts !== null) {
      ;(task.deadline_at ? plan.staleTargetsWithDeadline : plan.staleTargets).push({
        task,
        attempts,
      })
      continue
    }
    const ask = growthAsk(task, timezone, now, dayStart)
    if (ask) plan.growth.push({ task, ask })
  }
  plan.growth.sort((a, b) => b.ask.days_on_horizon - a.ask.days_on_horizon || a.task.id - b.task.id)
  const byAttempts = (a: { task: T; attempts: number }, b: { task: T; attempts: number }) =>
    b.attempts - a.attempts || a.task.id - b.task.id
  plan.staleTargets.sort(byAttempts)
  plan.staleTargetsWithDeadline.sort(byAttempts)
  return plan
}
