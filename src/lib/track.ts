/**
 * Track (REDESIGN-V03 §5) — the pure, client-safe half.
 *
 * `src/core/tasks/progress.ts` owns the mutation and imports the database; the
 * row component runs in the browser and only needs to read a task's tracked
 * state and name its period. Kept here so a client bundle never pulls core.
 */
import type { Task } from '@/types'

/** A tracked task is a quota: something to do N times per period, N > 1. */
export function isTracked(task: Pick<Task, 'progress_target'>): boolean {
  return (task.progress_target ?? 1) > 1
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
 * The period a quota counts within, as the user would say it — read from the
 * rrule's FREQ, which the §9 migration rewrote to the bare period
 * ("FREQ=WEEKLY" for "2x/week"). No rrule means no period: the count simply
 * accumulates until the task is completed.
 */
export function periodLabel(rrule: string | null | undefined): string | null {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  switch (freq) {
    case 'DAILY':
      return 'today'
    case 'WEEKLY':
      return 'this week'
    case 'MONTHLY':
      return 'this month'
    case 'YEARLY':
      return 'this year'
    default:
      return null
  }
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
