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
