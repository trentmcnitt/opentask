/**
 * DEADLINE-ANCHORED REPEATS — the write side (2026-10-21; docs/TASK-MODEL.md
 * § Recurrence Model). The dates themselves come from ONE pure function,
 * `occurrenceDates` (src/lib/task-segments.ts); this module decides what
 * schedule a create (`createAnchor`, `resolveRelativeTarget`) or a PATCH /
 * bulk edit (`planRepeatSchedule`) leaves, and refuses what can't be written:
 *
 *  - a rule WITH a deadline is deadline-anchored: its occurrence is the
 *    deadline (`deadline_at` mirrors `occurrence_at`) and its target sits
 *    `target_days_before` local days earlier at `target_time`. Inferred on
 *    create from `rrule` + `deadline_at` (API and AI callers create with the
 *    fields set; a 400 there would be friction); `repeat_anchor: 'target'`
 *    with a deadline is refused — a target-anchored repeat has none;
 *  - the rule is bound to the deadline's time: a timeless rule takes it, a
 *    rule at another time is refused;
 *  - the relative target: as sent; else the inverse of a `target_at` sent
 *    with it (`relativeTargetOf`); else — task-queue switch OFF — the default
 *    (`defaultRelativeTarget`, A1), or — switch ON (the deadlines page,
 *    2026-10-22, L1) — NONE: no fake target, each occurrence goes on the
 *    deadlines page from its lead day (`lead_from`). Validated (`relativeTargetProblem`): never after the deadline,
 *    never on or before the previous deadline;
 *  - never on a reminder or a quota (their date is their occurrence / they
 *    have none), never without a rule or a deadline; on a REPEAT the offsets
 *    only with the 'deadline' anchor, and together (a one-off with a deadline
 *    may carry them since 2026-10-24 — relative targets, `relative-target.ts`).
 * A PATCH also reschedules this occurrence (a deadline sent), switches the
 * anchor (with its rule), keeps a moved target (capped) and a deck (PR 4a,
 * `occurrenceIsPersonal`) and refuses clearing the deadline or the target —
 * `planRepeatSchedule`; `collectRepeatSchedule`
 * in helpers/collect-field-changes.ts writes what it decides.
 */

import { DateTime } from 'luxon'
import { ValidationError } from '@/core/errors'
import { openTaskLocalDay } from '@/lib/opentask-day'
import {
  computeFirstOccurrence,
  ensureRuleTime,
  parseRRule,
  ruleTimeOfDay,
} from '@/core/recurrence'
import { formatAnchorTime, utcToLocal } from '@/core/recurrence/timezone'
import {
  RELATIVE_TARGET_MESSAGES,
  capAtDeadline,
  deadlineWalk,
  occurrenceDayAtRuleTime,
  occurrenceIsPersonal,
  defaultRelativeTarget,
  occurrenceDates,
  relativeTargetOf,
  relativeTargetProblem,
  type RelativeTarget,
  type RepeatRule,
} from '@/lib/task-segments'
import type { RepeatAnchor, Task } from '@/types'

export const REPEAT_ANCHOR_KIND_MESSAGE =
  "repeat_anchor 'deadline' is for an ordinary repeating task: a reminder's date is its occurrence, and a quota has none"
export const REPEAT_ANCHOR_NEEDS_RULE_MESSAGE =
  "repeat_anchor 'deadline' needs a rule (rrule) and a deadline (deadline_at)"
export const TARGET_ANCHORED_DEADLINE_MESSAGE =
  "A repeating task anchored on its target has no deadline: send repeat_anchor 'deadline' to repeat the deadline, or no deadline_at"
export const RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE =
  "target_days_before and target_time are for a repeat anchored on its deadline (repeat_anchor 'deadline')"
export const RELATIVE_TARGET_PAIR_MESSAGE = 'Send target_days_before and target_time together'
export const RULE_NOT_ON_DEADLINE_MESSAGE =
  "A deadline-anchored rule repeats the deadline: its time (BYHOUR/BYMINUTE) must be the deadline's local time"
export const TARGET_AFTER_DEADLINE_MESSAGE = 'The target must not be after the deadline'
export const RULE_NEEDS_TIME_MESSAGE =
  'A deadline-anchored rule repeats the deadline: send deadline_at, or a rule with its time (BYHOUR/BYMINUTE)'

/** Whether the row a write leaves is an ordinary task (not a reminder, not a quota). */
export interface RowKind {
  isReminder: boolean
  isTracked: boolean
}

/**
 * The anchor a CREATE gives the row: 'deadline' when sent, or inferred from a
 * rule with a deadline on an ordinary task; else 'target'. Throws the 400s
 * that need no dates.
 */
export function createAnchor(
  input: {
    repeat_anchor?: RepeatAnchor
    target_days_before?: number
    target_time?: string
    deadline_at?: string | null
  },
  rrule: string | null | undefined,
  kind: RowKind,
): RepeatAnchor {
  const ordinary = !kind.isReminder && !kind.isTracked
  const hasDeadline = !!input.deadline_at
  if (input.repeat_anchor === 'deadline' && !ordinary) {
    throw new ValidationError(REPEAT_ANCHOR_KIND_MESSAGE)
  }
  if (input.repeat_anchor === 'deadline' && (!rrule || !hasDeadline)) {
    throw new ValidationError(REPEAT_ANCHOR_NEEDS_RULE_MESSAGE)
  }
  const anchor: RepeatAnchor =
    input.repeat_anchor ?? (rrule && hasDeadline && ordinary ? 'deadline' : 'target')
  if (anchor === 'target' && rrule && hasDeadline && ordinary) {
    throw new ValidationError(TARGET_ANCHORED_DEADLINE_MESSAGE)
  }
  const sentOffsets = [input.target_days_before, input.target_time].filter((v) => v !== undefined)
  // A target-anchored REPEAT has no offsets. A one-off may (relative targets,
  // 2026-10-24): `assertOneOffRelative` judges them in `createTask`.
  if (sentOffsets.length > 0 && anchor !== 'deadline' && rrule) {
    throw new ValidationError(RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE)
  }
  if (sentOffsets.length === 1) throw new ValidationError(RELATIVE_TARGET_PAIR_MESSAGE)
  return anchor
}

/** The local HH:MM of an instant. */
function localTime(iso: string, timezone: string): string {
  const local = utcToLocal(iso, timezone)
  return formatAnchorTime(local.hour, local.minute)
}

/**
 * A deadline-anchored rule must walk the deadline's time: refused when its
 * BYHOUR/BYMINUTE (or `anchorTime`) says another (`RULE_NOT_ON_DEADLINE_MESSAGE`).
 * The caller fills a timeless rule from the deadline first.
 */
export function assertRuleOnDeadline(
  rrule: string,
  anchorTime: string | null,
  deadlineAt: string,
  timezone: string,
): void {
  if (anchorTime === null && parseRRule(rrule).byhour === undefined) return
  const { hour, minute } = ruleTimeOfDay(rrule, anchorTime)
  if (formatAnchorTime(hour, minute) !== localTime(deadlineAt, timezone)) {
    throw new ValidationError(RULE_NOT_ON_DEADLINE_MESSAGE)
  }
}

/**
 * The relative target a deadline-anchored repeat is written with, validated
 * against its rule from its first deadline:
 *  - `sent`: the caller's own offsets;
 *  - else `targetAt` (a first target sent with the deadline `givenDeadline`):
 *    its inverse (`relativeTargetOf`) — refused when after the deadline;
 *  - else, with `leads` (the deadlines page, switch on — L1): null, NO
 *    relative target; without, the default (`defaultRelativeTarget`, A1).
 */
export function resolveRelativeTarget(opts: {
  sent: RelativeTarget | null
  targetAt: string | null
  givenDeadline: string
  rule: RepeatRule
  firstDeadline: string
  timezone: string
  morningTime: string
  leads?: boolean
}): RelativeTarget | null {
  const { rule, firstDeadline, timezone } = opts
  let offset = opts.sent
  if (!offset && opts.targetAt) {
    offset = relativeTargetOf(opts.targetAt, opts.givenDeadline, timezone)
    if (!offset) throw new ValidationError(TARGET_AFTER_DEADLINE_MESSAGE)
  }
  // One walk of the rule for both the default and the validation.
  if (!offset && opts.leads) return null
  const walk = deadlineWalk(rule, firstDeadline, timezone)
  offset ??= defaultRelativeTarget(rule, firstDeadline, timezone, opts.morningTime, walk)
  const problem = relativeTargetProblem(offset, rule, firstDeadline, timezone, walk)
  if (problem) throw new ValidationError(RELATIVE_TARGET_MESSAGES[problem])
  return offset
}

// ===========================================================================
// PATCH and bulk edit (`collectFieldChanges`)
// ===========================================================================

export const ANCHOR_SWITCH_NEEDS_RULE_MESSAGE =
  "Changing repeat_anchor changes what the rule's time means: send the rule (rrule) with it"
export const DEADLINE_CLEAR_MESSAGE =
  "This task repeats its deadline: to remove the deadline, send rrule null, or repeat_anchor 'target' with the rule"
export const REPEAT_TARGET_CLEAR_MESSAGE =
  'A repeating task anchored on its deadline always has a target: move it instead'
export const DECK_WITH_SCHEDULE_MESSAGE =
  'Send on_deck_day without a schedule change (rrule, deadline_at, repeat_anchor, target_days_before, target_time, target_slot_id): it sets its own date, which takes a task off deck'

/** The schedule fields of a PATCH (or a bulk edit's `changes`). */
export interface ScheduleInput {
  rrule?: string | null
  recurrence_mode?: 'from_due' | 'from_completion'
  deadline_at?: string | null
  due_at?: string | null
  repeat_anchor?: RepeatAnchor
  target_days_before?: number | null
  target_time?: string | null
  target_slot_id?: number | null
  on_deck_day?: string | null
}

/** The row fields the planner reads. */
type PlanTask = Pick<
  Task,
  | 'rrule'
  | 'recurrence_mode'
  | 'anchor_time'
  | 'deadline_at'
  | 'due_at'
  | 'occurrence_at'
  | 'repeat_anchor'
  | 'target_days_before'
  | 'target_time'
  | 'on_deck_day'
>

/**
 * What a write does to a repeating task's schedule:
 *  - `none`: nothing to do here (no rule, or a target-anchored repeat that
 *    stays one);
 *  - `target`: the row leaves deadline-anchored — the anchor and the offsets
 *    are written back to 'target' / null, and `clearDeadline` when it keeps
 *    its rule (L7: the deadline goes with the switch);
 *  - `deadline`: the row is (or becomes) deadline-anchored; the planner has
 *    decided its occurrence (= deadline), relative target, filled rule and —
 *    `dueAt` — the target this write leaves (undefined: unchanged).
 */
export type RepeatPlan =
  | { kind: 'none' }
  | { kind: 'target'; clearDeadline: boolean }
  | {
      kind: 'deadline'
      rrule: string | undefined
      /** Null: no relative target (the deadlines page holds each occurrence, L1). */
      relative: RelativeTarget | null
      occurrenceAt: string
      /** null: this occurrence is left with no target (A5, or no relative target). */
      dueAt: string | null | undefined
      /** The target the caller sent stopped at the deadline (`capped_at_deadline`). */
      capped: boolean
    }

interface PlanContext extends RowKind {
  timezone: string
  morningTime: string
  now: Date
  /** The user's day boundary (`dayBoundaryForUser` / `useDayStart`): a new rule's day 0. */
  dayStart: string
  /**
   * The deadlines page (task-queue switch on, 2026-10-22): no default
   * relative target (L1), and `target_at: null` removes THIS occurrence's
   * target (A5: it goes on the deadlines page) instead of a 400.
   */
  leads?: boolean
}

/** The facts every branch reads. */
interface Request {
  task: PlanTask
  input: ScheduleInput
  ctx: PlanContext
  /** The rule the write leaves. */
  rule: string | null
  ordinary: boolean
  wasDeadline: boolean
}

const sent = <T>(value: T | undefined, stored: T): T => (value !== undefined ? value : stored)

/**
 * THE PATCH SIDE (2026-10-21, plan §3.2). Judged on the RESULTING row, like
 * the quota invariants; every refusal is a 400 (in a bulk edit it refuses the
 * whole batch). A deadline-anchored result: `planDeadlineAnchored`.
 */
export function planRepeatSchedule(
  task: PlanTask,
  input: ScheduleInput,
  ctx: PlanContext,
): RepeatPlan {
  const req: Request = {
    task,
    input,
    ctx,
    rule: sent(input.rrule, task.rrule),
    ordinary: !ctx.isReminder && !ctx.isTracked,
    wasDeadline: !!task.rrule && task.repeat_anchor === 'deadline',
  }
  const switching = assertAnchorRequest(req)
  if (resultAnchor(req) === 'deadline') {
    assertNoDeckWithSchedule(input)
    return planDeadlineAnchored(req, switching || !req.wasDeadline)
  }
  return planTargetAnchored(req)
}

/**
 * The anchor's own 400s; returns whether the write SWITCHES a repeating
 * task's anchor (which needs its rule: the rule's time changes meaning, L7).
 */
function assertAnchorRequest({ task, input, rule, ordinary }: Request): boolean {
  if (input.repeat_anchor === 'deadline' && !ordinary) {
    throw new ValidationError(REPEAT_ANCHOR_KIND_MESSAGE)
  }
  if (input.repeat_anchor === 'deadline' && !rule) {
    throw new ValidationError(REPEAT_ANCHOR_NEEDS_RULE_MESSAGE)
  }
  const switching =
    !!task.rrule && input.repeat_anchor !== undefined && input.repeat_anchor !== task.repeat_anchor
  if (switching && input.rrule === undefined) {
    throw new ValidationError(ANCHOR_SWITCH_NEEDS_RULE_MESSAGE)
  }
  return switching
}

/**
 * The anchor the row is left with. A reminder or a quota is always
 * target-anchored: a conversion takes the anchor back with it (`'deadline'`
 * sent for one is refused above); so is a row with no rule.
 */
function resultAnchor({ task, input, rule, ordinary }: Request): RepeatAnchor {
  if (!rule || !ordinary) return 'target'
  if (input.repeat_anchor) return input.repeat_anchor
  return task.rrule && task.repeat_anchor === 'deadline' ? 'deadline' : 'target'
}

/** A deck write never travels with a schedule change: it sets its own date. */
function assertNoDeckWithSchedule(input: ScheduleInput): void {
  if (typeof input.on_deck_day !== 'string') return
  const schedule = [
    input.repeat_anchor,
    input.target_days_before,
    input.target_time,
    input.target_slot_id,
    input.deadline_at,
  ]
  if (schedule.some((v) => v !== undefined)) throw new ValidationError(DECK_WITH_SCHEDULE_MESSAGE)
}

/**
 * A TARGET-ANCHORED result. No offsets (400). L9 / A3: it never GAINS a
 * deadline — not by a deadline sent to one, nor by a rule given to a one-off
 * that has one (a legacy row that already carries one is left as it is). A
 * deadline-anchored row leaving its anchor (with its rule kept) loses its
 * deadline in the same write; one losing its rule keeps it, as a one-off.
 */
function planTargetAnchored({ task, input, rule, ordinary, wasDeadline }: Request): RepeatPlan {
  // A target-anchored REPEAT has no offsets; a ONE-OFF (no rule left) may —
  // relative targets, 2026-10-24, judged by `assertOneOffRelative`.
  if (rule && (input.target_days_before != null || input.target_time != null)) {
    throw new ValidationError(RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE)
  }
  const switching = wasDeadline && !!rule && ordinary
  const deadline = sent(input.deadline_at, task.deadline_at)
  const sentDeadline = input.deadline_at != null
  const ruleAdded = !task.rrule && input.rrule != null
  if (rule && ordinary && deadline !== null && (sentDeadline || ruleAdded) && !switching) {
    throw new ValidationError(TARGET_ANCHORED_DEADLINE_MESSAGE)
  }
  if (!wasDeadline) return { kind: 'none' }
  return { kind: 'target', clearDeadline: switching && input.deadline_at === undefined }
}

/** A deadline-anchored result's rule and where its schedule starts. */
interface DeadlineSchedule {
  /** The rule to store, when the write changes it (timed by the deadline). */
  rrule: string | undefined
  ruleFields: RepeatRule
  /** The deadline the write starts the schedule at, if any. */
  first: string | null
  /** A new rule, or the row becoming deadline-anchored. */
  scheduleChanged: boolean
}

/**
 * A DEADLINE-ANCHORED result (plan §3.2):
 *  - `deadline_at: null` and `target_at: null` are 400s (L8; A8 — "Back to
 *    schedule" — is not built);
 *  - THE RULE repeats the deadline (`deadlineRule`);
 *  - THE OCCURRENCE (= the deadline, `occurrenceFor`);
 *  - THE RELATIVE TARGET (`relativeFor`), validated when the rule's walk
 *    changes;
 *  - THE TARGET (`targetFor`).
 */
function planDeadlineAnchored(req: Request, becoming: boolean): RepeatPlan {
  const { input } = req
  if (input.deadline_at === null) throw new ValidationError(DEADLINE_CLEAR_MESSAGE)
  if (input.due_at === null && !req.ctx.leads) {
    throw new ValidationError(REPEAT_TARGET_CLEAR_MESSAGE)
  }
  const schedule = deadlineRule(req, becoming)
  const occurrenceAt = occurrenceFor(req, schedule, becoming)
  const { relative, validated } = relativeFor(req, schedule, occurrenceAt, becoming)
  const changed = validated || occurrenceAt !== req.task.occurrence_at
  const target = targetFor(req, { schedule, occurrenceAt, relative, changed, becoming })
  return { kind: 'deadline', rrule: schedule.rrule, relative, occurrenceAt, ...target }
}

/**
 * The rule, timed by the deadline it starts from: a timeless one takes the
 * deadline's local time (a 400 when there is none to take), one at another
 * time than a deadline sent with it is refused. A one-off given its rule
 * starts the schedule at its own deadline (A3).
 */
function deadlineRule({ task, input, rule, ctx }: Request, becoming: boolean): DeadlineSchedule {
  const ruleChanged = input.rrule !== undefined && input.rrule !== task.rrule
  const first = input.deadline_at ?? (task.rrule ? null : task.deadline_at)
  let rrule: string | undefined
  if (ruleChanged) {
    const timeless = parseRRule(rule!).byhour === undefined
    const timeFrom = first ?? task.deadline_at
    if (timeless && !timeFrom) throw new ValidationError(RULE_NEEDS_TIME_MESSAGE)
    rrule = timeless ? fillFromDeadline(rule!, timeFrom!, ctx.timezone) : rule!
    if (first) assertRuleOnDeadline(rrule, null, first, ctx.timezone)
  }
  return {
    rrule,
    first,
    scheduleChanged: becoming || ruleChanged,
    ruleFields: {
      rrule: rrule ?? rule!,
      recurrence_mode: input.recurrence_mode ?? task.recurrence_mode,
      anchor_time: rrule ? null : task.anchor_time,
    },
  }
}

/** Whether the row's target has already arrived. */
function overTarget(task: PlanTask, now: Date): boolean {
  return task.due_at !== null && Date.parse(task.due_at) < now.getTime()
}

/**
 * THE OCCURRENCE (= the deadline): a deadline sent reschedules THIS
 * occurrence (and starts a new schedule); with the schedule unchanged it
 * stays; a new rule on a repeat whose anchor stays and that is already over
 * target (the debt — the next done walks the new rule) or ON DECK (PR 4a: the
 * deck is for this occurrence) keeps its occurrence's DAY, at the new rule's
 * time, so the deadline is never left at a time the rule no longer has; else
 * the rule's first occurrence from now.
 */
function occurrenceFor(
  { task, ctx }: Request,
  schedule: DeadlineSchedule,
  becoming: boolean,
): string {
  if (schedule.first) return schedule.first
  const current = task.occurrence_at ?? task.deadline_at
  if (!schedule.scheduleChanged && current) return current
  const { rrule, anchor_time } = schedule.ruleFields
  const keepsDay = overTarget(task, ctx.now) || !!task.on_deck_day
  if (!becoming && keepsDay && task.occurrence_at) {
    return occurrenceDayAtRuleTime(task.occurrence_at, schedule.ruleFields, ctx.timezone)
  }
  const { hour, minute } = ruleTimeOfDay(rrule, anchor_time)
  return computeFirstOccurrence(
    rrule,
    formatAnchorTime(hour, minute),
    ctx.timezone,
    ctx.now,
    ctx.dayStart,
  ).toISOString()
}

/**
 * THE RELATIVE TARGET: the offsets sent, merged over the row's (both or
 * neither, else a 400); becoming deadline-anchored with none — the inverse of
 * a target sent with it, else the default (A1; `resolveRelativeTarget`
 * validates those). Kept offsets are validated when the RULE's walk changes
 * — a new rule or anchor, new offsets, a new mode — never for a reschedule of
 * this one occurrence (its date is the user's; the next comes from the rule).
 */
function relativeFor(
  { task, input, ctx }: Request,
  schedule: DeadlineSchedule,
  occurrenceAt: string,
  becoming: boolean,
): { relative: RelativeTarget | null; validated: boolean } {
  const days = sent(input.target_days_before, task.target_days_before)
  const time = sent(input.target_time, task.target_time)
  if ((days === null) !== (time === null)) throw new ValidationError(RELATIVE_TARGET_PAIR_MESSAGE)
  const pair = days !== null && time !== null ? { days_before: days, time } : null
  const offsetsSent = input.target_days_before !== undefined || input.target_time !== undefined
  const modeChanged = sent(input.recurrence_mode, task.recurrence_mode) !== task.recurrence_mode
  const validated = schedule.scheduleChanged || offsetsSent || modeChanged
  if (!pair || becoming) {
    // A target sent to a repeat that STAYS without a relative target (the
    // deadlines page, L1) is this occurrence's pick, never the series'
    // offsets; only a row becoming deadline-anchored takes them from it.
    const relative = resolveRelativeTarget({
      sent: pair,
      targetAt: becoming || !ctx.leads ? (input.due_at ?? null) : null,
      givenDeadline: occurrenceAt,
      rule: schedule.ruleFields,
      firstDeadline: occurrenceAt,
      timezone: ctx.timezone,
      morningTime: ctx.morningTime,
      leads: ctx.leads,
    })
    return { relative, validated }
  }
  if (validated) {
    const problem = relativeTargetProblem(pair, schedule.ruleFields, occurrenceAt, ctx.timezone)
    if (problem) throw new ValidationError(RELATIVE_TARGET_MESSAGES[problem])
  }
  return { relative: pair, validated }
}

/**
 * THE TARGET: a move the caller sent, capped at the deadline while it is
 * ahead (becoming deadline-anchored with no offsets, the offsets came from
 * it, so it IS the derived target); else, when the schedule or this
 * occurrence changed, its derived target — unless the task is ON DECK (PR 4a:
 * no target; the deck stays, and `collectDeckClear` re-runs A1 against the
 * deadline this write leaves — if that refuses, the deadline wins), the
 * target was MOVED this occurrence (kept, capped: §8.4's picked target) or,
 * on a schedule change, already over target (the debt, capped). Otherwise
 * unchanged.
 */
function targetFor(
  { task, input, ctx }: Request,
  plan: {
    schedule: DeadlineSchedule
    occurrenceAt: string
    relative: RelativeTarget | null
    changed: boolean
    becoming: boolean
  },
): { dueAt: string | null | undefined; capped: boolean } {
  const cap = (at: string) => capAtDeadline(at, plan.occurrenceAt, ctx.now)
  // A5 (2026-10-22, switch on): Remove target on ONE occurrence — it goes on
  // the deadlines page; the next advance re-derives the series' target.
  if (input.due_at === null) return { dueAt: null, capped: false }
  if (input.due_at != null) {
    const dueAt = cap(input.due_at)
    return { dueAt, capped: dueAt !== input.due_at }
  }
  if (!plan.changed || task.on_deck_day) return { dueAt: undefined, capped: false }
  const moved = !plan.becoming && occurrenceIsPersonal(task, ctx.timezone) === 'moved'
  const debt = plan.schedule.scheduleChanged && overTarget(task, ctx.now)
  if ((moved || debt) && task.due_at) return { dueAt: cap(task.due_at), capped: false }
  const derived = occurrenceDates(
    {
      rrule: plan.schedule.ruleFields.rrule,
      repeat_anchor: 'deadline',
      target_days_before: plan.relative?.days_before ?? null,
      target_time: plan.relative?.time ?? null,
    },
    plan.occurrenceAt,
    ctx.timezone,
  )
  return { dueAt: derived.targetAt, capped: false }
}

/** A timeless rule with the deadline's local time (`ensureRuleTime`). */
function fillFromDeadline(rule: string, deadline: string, timezone: string): string {
  return ensureRuleTime(rule, localTime(deadline, timezone))
}

// ===========================================================================
// REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends)
// ===========================================================================

/** How far ahead an end date may be — the same reach as skip until's date (`MAX_UNTIL_YEARS`). */
export const MAX_REPEAT_UNTIL_YEARS = 10
/** The largest "After N times". */
export const MAX_REPEAT_COUNT = 999

export type RepeatEndProblem =
  | 'count_range'
  | 'count_spent'
  | 'until_invalid'
  | 'until_past'
  | 'until_too_far'
  | 'until_before_occurrence'
  | 'both_ends'
  | 'ends_kind'
  | 'ends_need_rule'

/** The 400 for each `repeatEndProblem`. */
export const REPEAT_END_MESSAGES: Record<RepeatEndProblem, string> = {
  count_range: `repeat_count must be a whole number from 1 to ${MAX_REPEAT_COUNT}`,
  count_spent:
    'repeat_count must be more than the occurrences this series has already used (repeat_count_used)',
  until_invalid: 'repeat_until must be a date (yyyy-MM-dd)',
  until_past: 'repeat_until is in the past',
  until_too_far: `repeat_until is more than ${MAX_REPEAT_UNTIL_YEARS} years ahead`,
  until_before_occurrence:
    'repeat_until is before the current occurrence: the series would have no occurrence left',
  both_ends:
    'Send repeat_count or repeat_until, not both: a repeat ends after N times or on a date',
  ends_kind:
    'Only an ordinary repeating task can have an end: a reminder rolls forward on its own, and a quota counts within periods',
  ends_need_rule: 'An end (repeat_count / repeat_until) needs a repeat (rrule)',
}

/** What `repeatEndProblem` judges: the end the write LEAVES, and what it wrote. */
export interface RepeatEndCheck {
  count: number | null
  until: string | null
  /** `repeat_count_used` after the write. */
  used: number
  countWritten: boolean
  untilWritten: boolean
  /** The rule's walk changed (a new rule, mode or anchor). */
  walkWritten: boolean
  /** The occurrence the write leaves (a deadline-anchored repeat's: its deadline). */
  occurrenceAt: string | null
  hasRule: boolean
  isReminder: boolean
  isTracked: boolean
}

/**
 * THE END'S VALIDATION (pure — the POST, the PATCH and the editor's draft
 * share it). Judged on the RESULTING row:
 *  - an end needs a rule, and only an ordinary task has one (`ends_kind`,
 *    also when a write turns an ending task into a reminder or a quota);
 *  - one end at a time (`both_ends`);
 *  - a count written: 1..999, and more than the occurrences already used;
 *  - a date written: a real day, today or later (local), at most 10 years on;
 *  - a date written, or the rule's walk changed: not before the local date
 *    of the occurrence the write leaves. A reschedule of THIS occurrence's
 *    deadline past the end is not refused — that occurrence is already in
 *    the series.
 */
export function repeatEndProblem(
  check: RepeatEndCheck,
  timezone: string,
  now: Date,
  /** The user's day boundary: "today or later" is the OpenTask day's. */
  dayStart: string,
): RepeatEndProblem | null {
  const { count, until } = check
  if (count !== null && until !== null) return 'both_ends'
  if (count === null && until === null) return null
  if (!check.hasRule) return 'ends_need_rule'
  if (check.isReminder || check.isTracked) return 'ends_kind'
  if (count !== null) return check.countWritten ? countProblem(count, check.used) : null
  return untilProblem(until!, check, timezone, now, dayStart)
}

/** A count written: 1..999, and more than the occurrences already used (A7). */
function countProblem(count: number, used: number): RepeatEndProblem | null {
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT_COUNT) return 'count_range'
  return count <= used ? 'count_spent' : null
}

/**
 * A date end: a real day, today or later, not too far; not before the
 * occurrence. "Today" is the OpenTask day ("OpenTask day everywhere" part 2):
 * at 00:30 with a 3:00 AM start a repeat can still end on the day before.
 */
function untilProblem(
  until: string,
  check: RepeatEndCheck,
  timezone: string,
  now: Date,
  dayStart: string,
): RepeatEndProblem | null {
  if (check.untilWritten) {
    const day = parseLocalDay(until, timezone)
    if (!day) return 'until_invalid'
    const today = openTaskLocalDay(now, timezone, dayStart)
    if (day < today) return 'until_past'
    if (day > today.plus({ years: MAX_REPEAT_UNTIL_YEARS })) return 'until_too_far'
  }
  if ((check.untilWritten || check.walkWritten) && check.occurrenceAt) {
    const occurrenceDay = DateTime.fromISO(check.occurrenceAt, { zone: 'utc' })
      .setZone(timezone)
      .toISODate()!
    if (occurrenceDay > until) return 'until_before_occurrence'
  }
  return null
}

/** A yyyy-MM-dd day in the zone, or null when it isn't a real date (Luxon may throw on one). */
function parseLocalDay(day: string, timezone: string): DateTime | null {
  try {
    const parsed = DateTime.fromFormat(day, 'yyyy-MM-dd', { zone: timezone })
    return parsed.isValid ? parsed : null
  } catch {
    return null
  }
}
