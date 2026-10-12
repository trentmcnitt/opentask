/**
 * The editor's words for what the task model computes (2026-10-12, Trent's
 * morning QA): the auto target of a deadline-only task, and whether a recurring
 * task's deadline moves with each occurrence. Pure, so both are tested in
 * `tests/behavioral/tm-editor-labels.test.ts`; the rules themselves live in
 * `src/lib/task-segments.ts` and are only READ here, never restated.
 */

import { DateTime } from 'luxon'
import { parseRRuleParts } from '@/lib/format-rrule'
import { impliedTargetAt, type TargetContext, type TargetFields } from '@/lib/task-segments'

export interface AutoTargetLabel {
  /** The implied target itself (UTC ISO). */
  at: string
  /** Where it sits relative to the deadline: "4 days before deadline", "deadline day". */
  lead: string
  /** It has arrived: the task is nagging from it (over target). */
  started: boolean
}

/**
 * A task with a deadline and no target of its own nags from an IMPLIED target
 * (`impliedTargetAt`). The editor used to say "No target" for it while the task
 * was over target, which read as a contradiction. This names it instead.
 *
 * The lead is derived from the computed target, not from DEADLINE_LEAD_DAYS, so
 * it stays true under ruling A4: with `deadline_nag_off` set the implied target
 * is the deadline day's morning, and the label says "deadline day". Whole LOCAL
 * days between the two, in the user's zone.
 *
 * Only for a task with no target: a target of the user's own is shown as set
 * (a target past the deadline nags from the earlier implied one too, but that
 * line already shows a real date and the deadline sits right under it).
 */
export function describeAutoTarget(
  task: TargetFields,
  timezone: string,
  ctx?: TargetContext | null,
  now: Date = new Date(),
): AutoTargetLabel | null {
  if (task.due_at !== null || task.deadline_at === null) return null
  const at = impliedTargetAt(task, ctx, now)
  if (at === null) return null
  const zone = ctx?.timezone ?? timezone
  const atDay = DateTime.fromISO(at, { zone: 'utc' }).setZone(zone).startOf('day')
  const deadlineDay = DateTime.fromISO(task.deadline_at, { zone: 'utc' })
    .setZone(zone)
    .startOf('day')
  const days = Math.round(deadlineDay.diff(atDay, 'days').days)
  const lead = days <= 0 ? 'deadline day' : `${days} ${days === 1 ? 'day' : 'days'} before deadline`
  return { at, lead, started: Date.parse(at) <= now.getTime() }
}

const FREQ_UNITS: Record<string, string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
}

/**
 * "moves with each week" — said on a recurring task's deadline line, but only
 * when `advanceDeadline` really moves it: on done, skip and put-back it carries
 * the deadline to the next occurrence whenever the task has a deadline and an
 * occurrence to measure from (`original_due_at`, else `due_at`). A recurring
 * task always has one; the check keeps the claim honest if it ever doesn't.
 * Every-N rules and anything unusual say "each occurrence".
 */
export function deadlineRepeatLabel(task: {
  rrule: string | null | undefined
  deadline_at: string | null
  due_at: string | null
  original_due_at?: string | null
}): string | null {
  if (!task.rrule || !task.deadline_at) return null
  if (!(task.original_due_at ?? task.due_at)) return null
  const parts = parseRRuleParts(task.rrule)
  const unit = FREQ_UNITS[parts.FREQ ?? '']
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL) : 1
  return `moves with each ${unit && interval === 1 ? unit : 'occurrence'}`
}
