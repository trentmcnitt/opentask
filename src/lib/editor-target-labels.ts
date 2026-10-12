/**
 * The editor's words for what the task model decides (2026-10-12, Trent's
 * morning QA; §8): a deadline's automatic target, and whether a recurring
 * task's deadline moves with each occurrence. Pure, so both are tested in
 * `tests/behavioral/tm-editor-labels.test.ts`; the rules themselves live in
 * `src/lib/task-segments.ts` and are only READ here, never restated.
 */

import { DateTime } from 'luxon'
import { parseRRuleParts } from '@/lib/format-rrule'
import {
  autoTargetAt,
  deadlineDayTarget,
  type TargetContext,
  type TargetFields,
} from '@/lib/task-segments'
import { DEADLINE_DAY } from '@/lib/task-model-words'

export interface AutoTargetLabel {
  /** The automatic target itself (UTC ISO). */
  at: string
  /** Where it sits relative to the deadline: "3 days before deadline", "deadline day". */
  lead: string
  /** It has arrived: the task is nagging from it (over target). */
  started: boolean
}

/**
 * A deadline task whose target is the AUTOMATIC one (§8.1, `target_auto`)
 * shows it on the target line as "auto · Fri, Oct 16, 9:00 AM (3 days before
 * deadline)". The target is stored, so this reads it; the lead is whole LOCAL
 * days between it and the deadline, in the user's zone.
 *
 * `preview`: what Save would produce when the target is staged away — "Back
 * to auto" on a picked target, or a new deadline on an auto one. The server
 * re-derives it the same way (`autoTargetAt`, from now).
 *
 * Null for a task with a target the user picked, or no deadline.
 */
export function describeAutoTarget(
  task: TargetFields,
  timezone: string,
  ctx?: TargetContext | null,
  now: Date = new Date(),
  preview = false,
): AutoTargetLabel | null {
  if (task.deadline_at === null || task.rrule) return null
  let at: string
  if (preview || task.due_at === null) at = autoTargetAt(task.deadline_at, ctx, now)
  else if (task.target_auto) at = task.due_at
  else return null
  const zone = ctx?.timezone ?? timezone
  const atDay = DateTime.fromISO(at, { zone: 'utc' }).setZone(zone).startOf('day')
  const deadlineDay = DateTime.fromISO(task.deadline_at, { zone: 'utc' })
    .setZone(zone)
    .startOf('day')
  const days = Math.round(deadlineDay.diff(atDay, 'days').days)
  const lead = days <= 0 ? 'deadline day' : `${days} ${days === 1 ? 'day' : 'days'} before deadline`
  return { at, lead, started: Date.parse(at) <= now.getTime() }
}

/**
 * The editor's target line for a one-off ordinary task, read with the STAGED
 * values (§8, 2026-10-12): the automatic target to show, and whether a staged
 * change produced it (drawn blue). Shown when the stored target is automatic
 * and nothing is staged on it, or as a PREVIEW of what Save would produce —
 * "Back to auto" staged on a picked target, a new deadline on an automatic
 * target (it moves with the deadline), or a deadline added to a task with no
 * target. A picked date staged wins: that is a picked target. Null `label`:
 * the line shows the target as usual.
 */
export function stagedAutoTarget(
  task: Pick<TargetFields, 'due_at' | 'deadline_at' | 'target_auto'> | null | undefined,
  staged: {
    pendingDeadline: string | null | undefined
    targetCleared: boolean
    datePicked: boolean
  },
  timezone: string,
  ctx?: TargetContext | null,
  now: Date = new Date(),
): { label: AutoTargetLabel | null; staged: boolean } {
  const stored = task?.deadline_at ?? null
  const deadline = staged.pendingDeadline !== undefined ? staged.pendingDeadline : stored
  const deadlineChanged = staged.pendingDeadline !== undefined && staged.pendingDeadline !== stored
  const isStaged = staged.targetCleared || deadlineChanged
  const none = { label: null, staged: isStaged }
  if (!deadline || (staged.datePicked && !staged.targetCleared)) return none
  const storedAuto = task?.target_auto ?? false
  const storedDue = task?.due_at ?? null
  const preview = staged.targetCleared || (deadlineChanged && (storedAuto || storedDue === null))
  if (!preview && !storedAuto) return none
  const label = describeAutoTarget(
    { due_at: storedDue, deadline_at: deadline, target_auto: storedAuto, rrule: null },
    timezone,
    ctx,
    now,
    preview,
  )
  return { label, staged: isStaged }
}

/**
 * The pickers' "Deadline day" choice (ruling Q8, 2026-10-12): the user's
 * morning on the deadline's local day, or the deadline itself if earlier
 * (`deadlineDayTarget`) — "Deadline day · Fri 9:00 AM". Offered only while
 * that moment is still ahead; null otherwise (no deadline, or its day's
 * morning has passed). Shared by the snooze menu, the editor's target picker
 * and a task segment's Today picker.
 */
export function deadlineDayPick(
  deadlineAt: string | null | undefined,
  ctx: TargetContext,
  now: Date = new Date(),
): { label: string; at: string } | null {
  if (!deadlineAt) return null
  const at = deadlineDayTarget(deadlineAt, ctx)
  if (Date.parse(at) <= now.getTime()) return null
  const when = DateTime.fromISO(at, { zone: 'utc' }).setZone(ctx.timezone).toFormat('ccc h:mm a')
  return { label: `${DEADLINE_DAY} · ${when}`, at }
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
 * occurrence to measure from (`occurrence_at`, else `original_due_at`, else
 * `due_at`). A recurring task always has one; the check keeps the claim honest
 * if it ever doesn't. Every-N rules and anything unusual say "each occurrence".
 */
export function deadlineRepeatLabel(task: {
  rrule: string | null | undefined
  deadline_at: string | null
  due_at: string | null
  original_due_at?: string | null
  occurrence_at?: string | null
}): string | null {
  if (!task.rrule || !task.deadline_at) return null
  if (!(task.occurrence_at ?? task.original_due_at ?? task.due_at)) return null
  const parts = parseRRuleParts(task.rrule)
  const unit = FREQ_UNITS[parts.FREQ ?? '']
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL) : 1
  return `moves with each ${unit && interval === 1 ? unit : 'occurrence'}`
}

/**
 * A repeating task whose target has been moved off its scheduled occurrence
 * (§6, 2026-10-12): the editor names the occurrence — "This week's: Sun, Oct
 * 18, 12:00 PM" — so a moved target never reads as a changed schedule. Null
 * when the target is the occurrence (or the task is not repeating).
 */
export function movedOccurrenceLabel(
  task: { rrule: string | null | undefined; due_at: string | null; occurrence_at?: string | null },
  timezone: string,
): string | null {
  if (!task.rrule || !task.occurrence_at || !task.due_at) return null
  if (Date.parse(task.occurrence_at) === Date.parse(task.due_at)) return null
  return DateTime.fromISO(task.occurrence_at, { zone: 'utc' })
    .setZone(timezone)
    .toFormat('ccc, LLL d, h:mm a')
}
