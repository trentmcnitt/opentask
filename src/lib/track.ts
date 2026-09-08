/**
 * Track (REDESIGN-V03 §5) — the pure, client-safe half.
 *
 * `src/core/tasks/progress.ts` owns the mutation and imports the database; the
 * row component runs in the browser and only needs to read a task's tracked
 * state and name its period. Kept here so a client bundle never pulls core.
 */
import type { Task } from '@/types'

/**
 * A tracked task is a quota: something to do N times per period. N > 1 implies
 * it; `is_tracked` marks one with N = 1 ("date night, once a month").
 */
export function isTracked(task: Pick<Task, 'progress_target' | 'is_tracked'>): boolean {
  return task.is_tracked === true || (task.progress_target ?? 1) > 1
}

export interface TrackState {
  current: number
  target: number
  /** Reached (or passed) the target. The row stays open until the period rolls over. */
  met: boolean
  /** 0..1 of the target, capped — the bar never overflows even when the count does. */
  fraction: number
}

export function trackState(
  task: Pick<Task, 'progress_target' | 'progress_current'>,
  /** Optimistic override of `progress_current`, when a tap is in flight. */
  currentOverride?: number,
): TrackState {
  const target = Math.max(1, task.progress_target ?? 1)
  const current = Math.max(0, currentOverride ?? task.progress_current ?? 0)
  return { current, target, met: current >= target, fraction: Math.min(1, current / target) }
}

/**
 * The periods a quota can count within — ONE table, because it used to be five.
 *
 * The FREQ→period mapping was written out separately in `periodLabel`, in the
 * editor's chip list, in the editor's own copy of this regex, in
 * `periodShort`'s string rewriting and in `groupByPeriod`'s ordering — and two
 * of those had already drifted into silent data loss: a YEARLY quota and a
 * quota with no rule at all both read back as WEEKLY in the editor, so editing
 * only the target rewrote the schedule underneath the user (found 2026-09-06).
 * Anything that needs to know about periods reads this.
 */
export const QUOTA_PERIODS = [
  { freq: 'DAILY', label: 'today', short: 'day', editor: 'Every day' },
  { freq: 'WEEKLY', label: 'this week', short: 'week', editor: 'Every week' },
  { freq: 'MONTHLY', label: 'this month', short: 'month', editor: 'Every month' },
  { freq: 'YEARLY', label: 'this year', short: 'year', editor: 'Every year' },
] as const

export type QuotaFreq = (typeof QUOTA_PERIODS)[number]['freq']

/** The FREQ in an rrule, or null when there isn't one this app understands. */
export function quotaFreqOf(rrule: string | null | undefined): QuotaFreq | null {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  return QUOTA_PERIODS.find((p) => p.freq === freq)?.freq ?? null
}

/**
 * The period a quota counts within, as the user would say it — read from the
 * rrule's FREQ, which the §9 migration rewrote to the bare period
 * ("FREQ=WEEKLY" for "2x/week"). No rrule means no period: the count simply
 * accumulates until the task is completed.
 */
export function periodLabel(rrule: string | null | undefined): string | null {
  const freq = quotaFreqOf(rrule)
  return freq ? (QUOTA_PERIODS.find((p) => p.freq === freq)?.label ?? null) : null
}

/** "this week" → "week", for a card's heading. */
export function periodShort(label: string): string {
  return QUOTA_PERIODS.find((p) => p.label === label)?.short ?? label
}

export interface TrackSummary {
  /** Logged, each quota capped at its target — overflow on one never pays for another. */
  done: number
  /** The targets added up. */
  total: number
}

/** The folded panel's one number: "2 of 23 this week". */
export function trackSummary(
  tasks: Pick<Task, 'progress_target' | 'progress_current'>[],
): TrackSummary {
  let done = 0
  let total = 0
  for (const task of tasks) {
    const state = trackState(task)
    done += Math.min(state.current, state.target)
    total += state.target
  }
  return { done, total }
}

/**
 * Quotas by period, day-to-year, each group keeping the order it was given.
 *
 * Ordered by QUOTA_PERIODS rather than a hand-written list, so a period added
 * to the table cannot be silently dropped from the grouping — and the
 * period-less bucket is last and explicit, because a quota with no rule is a
 * real state rather than an oversight.
 */
export function groupByPeriod(
  quotas: Pick<Task, 'rrule'>[],
): { period: string | null; tasks: Task[] }[] {
  const order: (string | null)[] = [...QUOTA_PERIODS.map((p) => p.label), null]
  const by = new Map<string | null, Task[]>()
  for (const t of quotas as Task[]) {
    const p = periodLabel(t.rrule)
    by.set(p, [...(by.get(p) ?? []), t])
  }
  return order.filter((p) => by.has(p)).map((p) => ({ period: p, tasks: by.get(p)! }))
}

/**
 * What a label group's header says: how many quotas, and how many are met.
 *
 * NOT `trackSummary`. That adds targets up, which is honest for one period and
 * meaningless across several — "2 a day + 3 a week + 1 a month = 7" is a number
 * nobody can act on, and a label group mixes periods by construction. Counting
 * quotas survives the mixing, and "met" is per-quota (`trackState`), so it
 * means the same thing in every group.
 */
export function quotaGroupSummary(tasks: Pick<Task, 'progress_target' | 'progress_current'>[]): {
  count: number
  met: number
} {
  return { count: tasks.length, met: tasks.filter((t) => trackState(t).met).length }
}

/** The one label a quota is filed under: the first it carries, or none. */
export function quotaLabelOf(quota: Pick<Task, 'labels'>): string | null {
  return quota.labels?.[0] ?? null
}

/**
 * Quotas by label — the Quotas page's grouping (Trent, 2026-09-08: "I think we
 * need to have one label for quotas… there's a bunch of stuff for the kids and
 * there are other things").
 *
 * ONE label per quota: the editor writes a single entry, and a quota that
 * still carries two from before that rule is filed under the FIRST — the
 * migration deliberately left those rows alone, so this has to have an answer
 * for them rather than putting one quota in two places.
 *
 * Alphabetical, with the unlabelled group last: it is the leftovers, not a
 * name that happens to sort after "website". `sensitivity: 'base'` matches the
 * within-group order `trackedItems` uses, so the page sorts by one rule
 * throughout. Each group keeps the order it was given (that frozen alphabetical
 * order), because logging on one quota must never reorder the others under the
 * user's finger.
 *
 * The dashboard's Track panel deliberately still groups by PERIOD: it is an
 * instrument for "what is left this week", where the period is the question.
 * Here the period is on each row instead, since a label group mixes them.
 */
export function groupByLabel(
  quotas: Pick<Task, 'labels'>[],
): { label: string | null; tasks: Task[] }[] {
  const by = new Map<string | null, Task[]>()
  for (const t of quotas as Task[]) {
    const label = quotaLabelOf(t)
    by.set(label, [...(by.get(label) ?? []), t])
  }
  const labels = [...by.keys()]
    .filter((l): l is string => l !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const order: (string | null)[] = by.has(null) ? [...labels, null] : labels
  return order.map((label) => ({ label, tasks: by.get(label)! }))
}
