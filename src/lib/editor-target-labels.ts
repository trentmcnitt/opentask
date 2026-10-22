/**
 * The editor's words for what the task model decides (2026-10-12, Trent's
 * morning QA; §8): a deadline's automatic target, and whether a recurring
 * task's deadline moves with each occurrence. Pure, so both are tested in
 * `tests/behavioral/tm-editor-labels.test.ts`; the rules themselves live in
 * `src/lib/task-segments.ts` and are only READ here, never restated.
 */

import { DateTime } from 'luxon'
import {
  autoTargetAt,
  deadlineDayTarget,
  occurrenceDates,
  scheduleBase,
  targetMoved,
  type TargetContext,
  type TargetFields,
} from '@/lib/task-segments'
import { DEADLINE_DAY } from '@/lib/task-model-words'
import type { RepeatAnchor } from '@/types'

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
  // Never once the deadline has passed (Trent's ruling, 2026-10-12).
  if (!deadlineAt || Date.parse(deadlineAt) <= now.getTime()) return null
  const at = deadlineDayTarget(deadlineAt, ctx)
  if (Date.parse(at) <= now.getTime()) return null
  const when = DateTime.fromISO(at, { zone: 'utc' }).setZone(ctx.timezone).toFormat('ccc h:mm a')
  return { label: `${DEADLINE_DAY} · ${when}`, at }
}

/**
 * A DEADLINE-ANCHORED repeat's target, in words, on its deadline line
 * (2026-10-21): the deadline IS the schedule, so the line says where the
 * target sits before it — "target the day before at 6:00 PM", "target 3 days
 * before at 9:00 AM", "target the same day at 12:00 PM". Null for anything
 * else: a target-anchored repeat has no deadline, a one-off no rule.
 */
export function deadlineRepeatLabel(task: {
  rrule: string | null | undefined
  repeat_anchor?: RepeatAnchor | null
  target_days_before?: number | null
  target_time?: string | null
}): string | null {
  if (!task.rrule || task.repeat_anchor !== 'deadline') return null
  if (task.target_days_before == null || !task.target_time) return null
  return `target ${relativeTargetWords(task.target_days_before, task.target_time)}`
}

/**
 * A relative target in words (2026-10-22, editor plan §2.1): "the same day at
 * 12:00 PM", "the day before at 6:00 PM", "3 days before at 9:00 AM". Shared
 * by the deadline line (`deadlineRepeatLabel`) and every-time mode's Target
 * row, so both say it the same way.
 */
export function relativeTargetWords(daysBefore: number, time: string): string {
  const at = DateTime.fromFormat(time, 'HH:mm', { zone: 'utc' }).toFormat('h:mm a')
  return `${relativeDaysWords(daysBefore)} at ${at}`
}

/** "the same day", "the day before", "3 days before" — the days-before select's choices. */
export function relativeDaysWords(daysBefore: number): string {
  if (daysBefore === 0) return 'the same day'
  return daysBefore === 1 ? 'the day before' : `${daysBefore} days before`
}

/**
 * "THIS IS THE FRI OCT 16 ONE" (2026-10-22, editor plan §7, A4): the line
 * under a repeating task's title naming WHICH occurrence the this-one rows
 * edit — shown only when the occurrence differs from what its rule alone
 * would say, i.e. when any of:
 *  (a) it is ON DECK (`on_deck_day`): its target is cleared, the deck names a day;
 *  (b) its target was MOVED this occurrence (`targetMoved`);
 *  (c) it is QUEUED (`queuedRepeatOccurrence`, with the queue switch on): the
 *      stored target has moved on to the next occurrence;
 *  (d) it was RESCHEDULED off its rule — a deadline-anchored, from_due repeat
 *      whose deadline was moved for this occurrence (`scheduleBase` differs
 *      from `occurrence_at`).
 * NOT for plain over-target debt (the Target row already says "5 days ago" in
 * red) nor an occurrence on its rule. Never for a done task or a one-off.
 *
 * Names `occurrence_at`'s local day ("Fri Oct 16") — on a deadline-anchored
 * repeat that is the DEADLINE's day, so it reads "Sat Nov 7 (deadline)" when
 * the target (moved, or derived) falls on another day.
 */
export function occurrenceDiffers(
  task: {
    rrule: string | null | undefined
    done?: boolean
    due_at: string | null
    occurrence_at?: string | null
    queued_at?: string | null
    on_deck_day?: string | null
    recurrence_mode?: 'from_due' | 'from_completion' | null
    anchor_time?: string | null
    repeat_anchor?: RepeatAnchor | null
    target_days_before?: number | null
    target_time?: string | null
  },
  timezone: string,
  queueEnabled: boolean,
): string | null {
  if (!task.rrule || task.done || !task.occurrence_at) return null
  const schedule = {
    rrule: task.rrule,
    repeat_anchor: task.repeat_anchor ?? null,
    target_days_before: task.target_days_before ?? null,
    target_time: task.target_time ?? null,
  }
  const differs =
    !!task.on_deck_day ||
    targetMoved(
      { ...schedule, due_at: task.due_at, occurrence_at: task.occurrence_at },
      timezone,
    ) ||
    (queueEnabled && queuedRepeatOccurrence(task) !== null) ||
    rescheduledOffRule(task, timezone)
  if (!differs) return null
  const occurrence = DateTime.fromISO(task.occurrence_at, { zone: 'utc' }).setZone(timezone)
  const day = occurrence.toFormat('ccc LLL d')
  if (task.repeat_anchor !== 'deadline') return day
  const target = task.due_at ?? occurrenceDates(schedule, task.occurrence_at, timezone).targetAt
  const targetDay = DateTime.fromISO(target, { zone: 'utc' }).setZone(timezone)
  return targetDay.hasSame(occurrence, 'day') ? day : `${day} (deadline)`
}

/** (d): a deadline-anchored from_due occurrence moved off its rule (`scheduleBase`). */
function rescheduledOffRule(
  task: Parameters<typeof occurrenceDiffers>[0],
  timezone: string,
): boolean {
  if (task.repeat_anchor !== 'deadline' || task.recurrence_mode === 'from_completion') return false
  try {
    const base = scheduleBase(
      {
        rrule: task.rrule ?? null,
        repeat_anchor: task.repeat_anchor,
        recurrence_mode: task.recurrence_mode,
        anchor_time: task.anchor_time ?? null,
        occurrence_at: task.occurrence_at,
        due_at: task.due_at,
      },
      timezone,
    )
    return base !== null && Date.parse(base) !== Date.parse(task.occurrence_at!)
  } catch {
    // A rule with no next occurrence: nothing to compare against.
    return false
  }
}

/**
 * A repeating task whose target has been moved off its scheduled occurrence
 * (§6, 2026-10-12; `targetMoved`): the editor names the occurrence's own
 * target — "This week's: Sun, Oct 18, 12:00 PM" — so a moved target never
 * reads as a changed schedule. For a deadline-anchored repeat (2026-10-21)
 * that is the target derived from its deadline (`occurrenceDates`). Null
 * when the target is not moved (or the task is not repeating).
 */
export function movedOccurrenceLabel(
  task: {
    rrule: string | null | undefined
    due_at: string | null
    occurrence_at?: string | null
    queued_at?: string | null
    repeat_anchor?: RepeatAnchor | null
    target_days_before?: number | null
    target_time?: string | null
  },
  timezone: string,
): string | null {
  if (!task.rrule || !task.occurrence_at || !task.due_at) return null
  if (queuedRepeatOccurrence(task)) return null
  const schedule = {
    rrule: task.rrule,
    repeat_anchor: task.repeat_anchor ?? null,
    target_days_before: task.target_days_before ?? null,
    target_time: task.target_time ?? null,
  }
  if (
    !targetMoved({ ...schedule, due_at: task.due_at, occurrence_at: task.occurrence_at }, timezone)
  )
    return null
  return DateTime.fromISO(occurrenceDates(schedule, task.occurrence_at, timezone).targetAt, {
    zone: 'utc',
  })
    .setZone(timezone)
    .toFormat('ccc, LLL d, h:mm a')
}

/**
 * A repeating task WAITING in the task queue (B3, task queue PR 2): the
 * rollover moved its target (`due_at`) on to the next occurrence and kept
 * `occurrence_at` on the one it missed, which is the one the queue row stands
 * for. The row and its details show THAT date — "Oct 16 · every Fri at 4 PM",
 * not the moved target "Oct 23", and no "Target … in 3 days" / "· target
 * moved" (Trent, 2026-10-20: "What does that even mean?"). No "missed" word
 * either (his ruling): just the occurrence's date.
 *
 * The occurrence (UTC ISO) for such a task, else null. Keyed on the queue
 * state itself — `queued_at` set on a repeating task — which the rollover
 * clears when the wait ends (`release`), and a new target clears on any
 * write (`stampTargetSet`). A repeating task NOT in the queue whose target the
 * user moved keeps its "Occurrence … · target moved" line
 * (`movedOccurrenceLabel`).
 */
export function queuedRepeatOccurrence(task: {
  rrule: string | null | undefined
  occurrence_at?: string | null
  queued_at?: string | null
}): string | null {
  if (!task.rrule || !task.queued_at || !task.occurrence_at) return null
  return task.occurrence_at
}

/**
 * Where the Quick panel's date controls (increments, delta, pickers) start
 * for a task: its target — or, for a repeating task waiting in the task queue
 * (`queuedRepeatOccurrence`, with the queue switch on), null, i.e. now, as
 * for a task with no target. Its stored target is a moved one and its
 * occurrence is past, so "+1 day" from either would stage a date nobody
 * picked (from the missed Fri Oct 16: Sat Oct 17, already over target).
 */
export function pickerBaseDueAt(
  task: {
    rrule: string | null | undefined
    due_at: string | null
    occurrence_at?: string | null
    queued_at?: string | null
  },
  queueEnabled: boolean,
): string | null {
  if (queueEnabled && queuedRepeatOccurrence(task)) return null
  return task.due_at
}

/**
 * The Quick panel's Repeat button (2026-10-20): whether it reads ACTIVE — a
 * rule is set — and its label. `rule` is the staged or stored rule; pass
 * undefined in a multi-selection with nothing staged, where every selected
 * task must repeat. Active leads the label with the rule ("Repeats: Fridays at
 * 4:00 PM · Edit recurrence"); the button never claims `aria-pressed`, since a
 * tap opens the editor and never switches the rule off (see the button).
 */
export function repeatButtonState({
  rule,
  selectedTasks,
  recurrenceText,
  editing,
}: {
  rule: string | null | undefined
  selectedTasks: { rrule: string | null }[] | undefined
  recurrenceText: string | null
  editing: boolean
}): { repeatActive: boolean; repeatButtonLabel: string } {
  const repeatActive =
    selectedTasks && rule === undefined
      ? selectedTasks.length > 0 && selectedTasks.every((t) => !!t.rrule)
      : !!rule
  if (editing) return { repeatActive, repeatButtonLabel: 'Close recurrence editor' }
  if (!repeatActive) return { repeatActive, repeatButtonLabel: 'Edit recurrence' }
  const what = recurrenceText && recurrenceText !== '—' ? `: ${recurrenceText}` : ''
  return { repeatActive, repeatButtonLabel: `Repeats${what} · Edit recurrence` }
}
