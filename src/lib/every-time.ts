/**
 * THE TASK EDITOR'S "EVERY TIME" MODE — the pure core (2026-10-22, editor plan
 * §4–§6, PR 4b; approved A1–A12). The Quick panel edits a repeating task in
 * two modes: THIS ONE (this occurrence's target, deadline, deck) and EVERY
 * TIME (the schedule: the rule, which date it repeats, the target's place
 * before a repeated deadline, how it ends, what it is scheduled from). This
 * module is everything every-time mode decides, with no UI:
 *
 *  - `EveryTimeDraft` and `draftFromTask`: the schedule as the panel edits it.
 *    The target's and the deadline's times are kept apart, so the order of
 *    edits never matters; the rule's time is bound only when it is built —
 *    the deadline's on a deadline-anchored draft, else the target's — so
 *    every PATCH carries a rule at the right time (RT-2);
 *  - `draftReducer`: the transitions (§4.3), including the two that move the
 *    rule's DAYS (`src/core/recurrence/rule-shift.ts`): "+ Add" a deadline
 *    earlier in the day than the target puts it on the NEXT day (A2), and
 *    leaving a deadline-anchored repeat for its target moves the rule onto
 *    the target's days (A3) — each refused (`refusal`) when the shift can't
 *    be written as the rule's own days;
 *  - `draftToPatch`: exactly what one Save sends (§5) — one PATCH, one undo;
 *  - `draftProblem`: why Save is disabled, asked of the SERVER'S OWN planner
 *    (`planRepeatSchedule`, which is browser-safe — RT-11's guard test walks
 *    its imports) plus the route's rule validation (`isValidRRule`), so a 400
 *    can only come from a race;
 *  - `nextDates`, `daysBeforeChoices`, `targetTimeRefused`: the "Next" preview
 *    and the greyed choices, sharing ONE memoised walk of the rule (RT-9);
 *  - `thisOneHint`: what a Save does to THIS occurrence (§5.6);
 *  - `bulkEveryTimeGate` / `draftToBulkChanges`: the limited bulk mode (A11).
 *
 * ENDS (repeat ends, 2026-10-22; plan-repeat-ends §7 item 3 — A10 is
 * superseded): Never / After N times / On date. The stored rule is end-free:
 * the end is the task's `repeat_count` (+ `repeat_count_used`) or
 * `repeat_until`, never COUNT/UNTIL in the rule (`buildRule` writes neither).
 *  - `draftFromTask` reads the end from those fields;
 *  - `draftToPatch` sends `repeat_count` / `repeat_until` only when the end
 *    changed — the rule text is compared on its own, so an unchanged pattern
 *    is never re-sent (a target-anchored rule change re-dates the target);
 *  - `draftProblem` asks the server's own end check (`repeatEndProblem`, the
 *    same pure function the PATCH runs) — the planner doesn't judge ends;
 *  - `nextDates` cuts the walk with the server's end judge (`repeatStep`):
 *    the Next list stops at the last occurrence and marks it "· last one".
 *    COUNTING: the first Next date is the current occurrence (#used+1), so
 *    "After 3 times" set fresh (used 0) shows three dates, the third the last.
 */

import { DateTime } from 'luxon'
import {
  computeFirstOccurrence,
  computeNextOccurrence,
  NEVER_OCCURS_MESSAGE,
  ruleTimeOfDay,
} from '@/core/recurrence/compute-next'
import { isValidRRule } from '@/core/recurrence/rrule-builder'
import { setRuleTime } from '@/core/recurrence/rule-time'
import { shiftRuleDays, shiftedRuleHolds } from '@/core/recurrence/rule-shift'
import {
  REPEAT_END_MESSAGES,
  TARGET_AFTER_DEADLINE_MESSAGE,
  planRepeatSchedule,
  repeatEndProblem,
  type RepeatEndProblem,
  type RepeatPlan,
  type ScheduleInput,
} from '@/core/tasks/repeat-schedule'
import { formatTime } from '@/lib/format-rrule'
import { leadDaysWords, relativeDaysWords } from '@/lib/editor-target-labels'
import { UPCOMING_SECTION_TITLES } from '@/lib/task-model-words'
import { localMoment, openTaskLocalDay } from '@/lib/opentask-day'
import {
  RULE_DAYS,
  buildRule,
  parseHHMM,
  parseRule,
  ruleDraftable,
  toHHMM,
  weeklyDayMissing,
  type RuleDraft,
  type RuleFrequency,
} from '@/lib/rrule-draft'
import {
  HEADS_UP_DAY_BEFORE_MIN_WAIT,
  RELATIVE_TARGET_MESSAGES,
  deadlineDateFrom,
  deadlineLeadDays,
  deadlineWalk,
  defaultRelativeTarget,
  isDeadlineAnchored,
  occurrenceDates,
  relativeOf,
  relativeTargetOf,
  relativeTargetProblem,
  occurrenceIsPersonal,
  targetMoved,
  repeatEndOf,
  repeatStep,
  ruleWait,
  type RelativeTarget,
  type RelativeTargetProblem,
  type RepeatRule,
} from '@/lib/task-segments'
import type { RepeatAnchor, Task } from '@/types'

// ===========================================================================
// Types
// ===========================================================================

type Mode = 'from_due' | 'from_completion'

/** The task fields every-time mode reads (a `Task` satisfies it). */
export type EveryTimeTask = Pick<
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
> & {
  queued_at?: string | null
  done?: boolean
  /** The repeat's end (repeat ends, 2026-10-22); absent reads as none. */
  repeat_count?: number | null
  repeat_count_used?: number | null
  repeat_until?: string | null
  /** The deadlines page's lead override (2026-10-22); absent reads as the default. */
  lead_days?: number | null
  /**
   * The reminder period the relative target's time follows (relative targets,
   * 2026-10-24); absent reads as none (a custom time).
   */
  target_slot_id?: number | null
}

/** What the module needs besides the task. `now` is injectable for tests. */
export interface EveryTimeContext {
  timezone: string
  /** The user's Morning time (HH:MM), the default target time. */
  morningTime: string
  now: Date
  /**
   * The user's day boundary (`useDayStart`): "today" is the OpenTask day
   * ("OpenTask day everywhere" part 2, Trent 2026-10-26). A new weekly rule
   * with no day of its own takes the OpenTask day's weekday, and a rule's
   * first occurrence counts from it — at 00:30 Monday with a 3:00 AM start,
   * exactly as at 23:30 Sunday.
   */
  dayStart: string
  /**
   * The deadlines page is on (the task-queue switch, 2026-10-22, plan L1): a
   * one-off with a deadline and no target turned into a deadline-anchored
   * repeat gets NO default relative target (`noTarget`) — its occurrences go
   * on the deadlines page from their lead day instead.
   */
  leads?: boolean
  /**
   * The period "Default task time" follows (ruling 10, relative targets
   * 2026-10-24): a default relative target at that time copies the link, as
   * the setting has it. Null (or absent) for a custom time — and on a task
   * the user doesn't own, whose periods are the owner's.
   */
  morningSlotId?: number | null
}

/** The schedule being edited (plan §4.2). */
export interface EveryTimeDraft {
  /** What the rule repeats: the target, or the deadline (the target derived from it). */
  anchor: RepeatAnchor
  /** The rule's days, interval and end — no time (`buildRule` binds it). */
  rule: RuleDraft
  /** HH:MM — a target-anchored rule's time, or a deadline-anchored target's. */
  targetTime: string
  /** HH:MM — a deadline-anchored rule's time; null while target-anchored. */
  deadlineTime: string | null
  /** Local days from the deadline back to the target (deadline-anchored only). */
  daysBefore: number
  /**
   * The reminder period `targetTime` follows (relative targets, 2026-10-24),
   * or null for a custom time — deadline-anchored only; `targetTime` is then
   * the period's start. Absent reads as null.
   */
  targetSlotId?: number | null
  /**
   * Deadline-anchored with NO relative target (2026-10-22, L1: the deadlines
   * page holds each occurrence): `targetTime` / `daysBefore` are only the
   * picker's starting point and are not sent. Picking either sets a target.
   */
  noTarget?: boolean
  /**
   * The series' lead override (`lead_days`; series-wide, so it is edited
   * here, never in this-one mode — Trent, 10-22): null = the default table.
   * On a deadline-anchored draft with no target (the deadlines page,
   * 2026-10-22) the days before each deadline its occurrence goes on the
   * page; on any other repeat (2026-10-25, the Upcoming split) the days
   * before each target it shows in Upcoming's Later section. Absent reads as
   * the stored value.
   */
  leadDays?: number | null
  mode: Mode
  /** "Stop repeating" is staged. */
  stop: boolean
  /** The weekday a WEEKLY rule with no day picks up (the task's own, else today's). */
  defaultDay: string
  /**
   * Why the last anchor change was refused (A2/A3: the day shift can't be
   * written), shown inline until the next action. The draft itself is left
   * as it was, so this never blocks a Save of other edits.
   */
  refusal: string | null
}

/** One Save of every-time mode: the PATCH body (only the fields that change). */
export interface EveryTimePatch {
  rrule?: string | null
  recurrence_mode?: Mode
  repeat_anchor?: RepeatAnchor
  deadline_at?: string | null
  target_days_before?: number
  target_time?: string
  /**
   * The period the target's time follows: sent INSTEAD of `target_time` (the
   * server sets the time to the period's start); a `target_time` alone is a
   * custom time and drops the link.
   */
  target_slot_id?: number
  /** "After N times" (null: no count). Sent only when the end changed. */
  repeat_count?: number | null
  /** "On date": the last local day, yyyy-MM-dd (null: no date). */
  repeat_until?: string | null
  /** The series' lead override (the deadlines page, or Upcoming's Later); null = the default. */
  lead_days?: number | null
}

// ===========================================================================
// Small helpers
// ===========================================================================

const local = (iso: string, timezone: string) =>
  DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone)

function localHHMM(iso: string, timezone: string): string {
  return local(iso, timezone).toFormat('HH:mm')
}

/** The RRULE weekday of a stored moment's own local date (an occurrence's, a target's). */
function weekdayOf(iso: string, timezone: string): string {
  return RULE_DAYS[local(iso, timezone).weekday - 1]
}

/** The RRULE weekday of TODAY — the OpenTask day `ctx.now` is in, not its calendar date. */
function todayWeekday(ctx: EveryTimeContext): string {
  return RULE_DAYS[openTaskLocalDay(ctx.now, ctx.timezone, ctx.dayStart).weekday - 1]
}

/** "4:00 PM" from "16:00". */
export function hhmmWords(time: string): string {
  const t = parseHHMM(time) ?? { hour: 0, minute: 0 }
  return formatTime(t.hour, t.minute)
}

/** "Mon Oct 26, 9:00 AM" — the hint's and the stop line's dates. */
function whenWords(iso: string, timezone: string): string {
  return local(iso, timezone).toFormat('ccc LLL d, h:mm a')
}

function storedMode(task: EveryTimeTask | null): Mode {
  return task?.recurrence_mode ?? 'from_due'
}

/** The draft's rule as RRULE text, at the time its anchor binds (RT-2). */
export function draftRule(draft: EveryTimeDraft): string {
  const time =
    draft.anchor === 'deadline' && draft.deadlineTime ? draft.deadlineTime : draft.targetTime
  return buildRule(draft.rule, time)
}

function ruleFields(rrule: string, mode: Mode): RepeatRule {
  return { rrule, recurrence_mode: mode, anchor_time: null }
}

/** A NEVER_OCCURS-safe first occurrence of a rule from now. */
function firstFromNow(rrule: string, ctx: EveryTimeContext): string | null {
  try {
    return computeFirstOccurrence(rrule, null, ctx.timezone, ctx.now, ctx.dayStart).toISOString()
  } catch {
    return null
  }
}

// ===========================================================================
// THE UPCOMING LEAD STEPPER (2026-10-25, the Upcoming split)
// ===========================================================================

/**
 * The every-time LEAD row of a repeat WITH a target (target-anchored, or
 * deadline-anchored with a relative target): how many days before each
 * occurrence's target it shows in Upcoming's Later section. `fallback` is the
 * default the table gives the rule's wait (`deadlineLeadDays(ruleWait)` —
 * the wait after an on-time completion), `max` the server's bound (one less
 * than the wait, `leadDaysProblem`). Null when the rule has no Upcoming at
 * all (a wait under 2 days: daily — any override would be refused), when the
 * draft is the deadlines page's (no target: its own stepper, `NoTargetRow`),
 * or when the rule can't be read.
 */
export function upcomingLeadStep(
  task: Pick<EveryTimeTask, 'occurrence_at' | 'due_at' | 'deadline_at' | 'lead_days'>,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): { lead: number; fallback: number; max: number; reset: boolean } | null {
  if (draft.noTarget) return null
  const wait = draftWait(task, draft, ctx)
  if (wait === null || wait < HEADS_UP_DAY_BEFORE_MIN_WAIT) return null
  const max = Math.max(1, Math.min(90, wait - 1))
  const fallback = Math.max(1, deadlineLeadDays(wait))
  const reset = leadResetForRule(task, draft, ctx)
  return {
    lead: reset ? fallback : Math.min(max, draft.leadDays ?? fallback),
    fallback,
    max,
    reset,
  }
}

/** The draft rule's wait (`ruleWait`) from its first occurrence, or null when it can't be read. */
function draftWait(
  task: Pick<EveryTimeTask, 'occurrence_at' | 'due_at' | 'deadline_at'>,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): number | null {
  const deadline = draft.anchor === 'deadline'
  const first =
    (deadline ? task.deadline_at : (task.occurrence_at ?? task.due_at)) ?? ctx.now.toISOString()
  try {
    return ruleWait(
      {
        rrule: draftRule(draft),
        recurrence_mode: draft.mode,
        anchor_time: deadline ? draft.deadlineTime : draft.targetTime,
      },
      first,
      ctx.timezone,
    )
  } catch {
    return null
  }
}

/** The Lead time row's note when `leadResetForRule` holds (Trent's coordinator, 10-25). */
export const LEAD_RESET_FOR_RULE = 'Lead time back to default for the new rule'

/**
 * A SHORTER RULE RESETS THE LEAD (2026-10-25): a repeat's lead must be
 * shorter than its rule's wait (the server's `leadDaysProblem`, a 400). When
 * the draft's rule makes the stored or staged lead too long — a weekly with a
 * lead of 3 made daily — the same Save sends `lead_days: null` (back to the
 * default) instead of failing, and the Lead time row says so
 * (`LEAD_RESET_FOR_RULE`). Derived, never written into the draft: change the
 * rule back and the lead is valid again, kept.
 */
export function leadResetForRule(
  task: Pick<EveryTimeTask, 'occurrence_at' | 'due_at' | 'deadline_at' | 'lead_days'>,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): boolean {
  if (draft.stop) return false
  const lead = draft.leadDays !== undefined ? draft.leadDays : (task.lead_days ?? null)
  if (lead === null) return false
  const wait = draftWait(task, draft, ctx)
  return wait !== null && lead >= wait
}

/**
 * The row's words: "Later 3 days before each one · Tomorrow the day before";
 * a lead of 1 has no Later — "Tomorrow the day before each one".
 */
export function upcomingLeadStepWords(lead: number): string {
  if (lead <= 1) return `${UPCOMING_SECTION_TITLES.tomorrow} the day before each one`
  return `${UPCOMING_SECTION_TITLES.later} ${leadDaysWords(lead)} each one · ${UPCOMING_SECTION_TITLES.tomorrow} the day before`
}

// ===========================================================================
// draftFromTask
// ===========================================================================

/**
 * The draft a task opens every-time mode with (plan §4.2, §2.2):
 *  - target-anchored: the rule, its time as the target's;
 *  - deadline-anchored: the rule, its time as the deadline's, the stored
 *    relative target;
 *  - a one-off: "Weekly on <its day>" at its time (the server's order for a
 *    rule sent without one: anchor, else its target's time, else Morning).
 *    A one-off WITH a deadline opens on Deadline (§5.3/§5.4: a deadline
 *    survives only a deadline-anchored repeat), pinned to the deadline's
 *    weekday and time, its target's offset kept when it can be (else the
 *    default, A1).
 * Create mode passes `createModeTask(staged)`.
 */
export function draftFromTask(task: EveryTimeTask, ctx: EveryTimeContext): EveryTimeDraft {
  const { timezone } = ctx
  const mode = storedMode(task)
  if (task.rrule) {
    const rule = withStoredEnd(parseRule(task.rrule)!, task)
    const { hour, minute } = ruleTimeOfDay(task.rrule, task.anchor_time)
    const ruleTime = toHHMM(hour, minute)
    const day = task.occurrence_at ?? task.due_at
    const base = {
      rule,
      mode,
      stop: false,
      refusal: null,
      defaultDay: day ? weekdayOf(day, timezone) : todayWeekday(ctx),
      leadDays: task.lead_days ?? null,
    }
    if (isDeadlineAnchored(task)) {
      return {
        ...base,
        anchor: 'deadline',
        deadlineTime: ruleTime,
        targetTime: task.target_time ?? ruleTime,
        daysBefore: task.target_days_before ?? 0,
        targetSlotId: relativeOf(task) ? (task.target_slot_id ?? null) : null,
        ...(task.target_days_before === null || task.target_time === null
          ? { noTarget: true }
          : {}),
      }
    }
    return {
      ...base,
      anchor: 'target',
      targetTime: ruleTime,
      deadlineTime: null,
      daysBefore: 0,
      targetSlotId: null,
    }
  }
  return oneOffDraft(task, ctx)
}

/** The draft's end, from the task's end fields (never from the rule text). */
function withStoredEnd(rule: RuleDraft, task: EveryTimeTask): RuleDraft {
  const end = repeatEndOf(task)
  if (end.repeat_count !== null) return { ...rule, endType: 'count', endCount: end.repeat_count }
  if (end.repeat_until !== null) return { ...rule, endType: 'date', endDate: end.repeat_until }
  return { ...rule, endType: 'never' }
}

/** The end a draft asks for, as the two fields. A date end with no date yet is none. */
export function draftEnd(draft: EveryTimeDraft): { count: number | null; until: string | null } {
  if (draft.rule.endType === 'count') return { count: draft.rule.endCount, until: null }
  if (draft.rule.endType === 'date' && draft.rule.endDate) {
    return { count: null, until: draft.rule.endDate }
  }
  return { count: null, until: null }
}

function oneOffDraft(task: EveryTimeTask, ctx: EveryTimeContext): EveryTimeDraft {
  const { timezone } = ctx
  const time =
    task.anchor_time ?? (task.due_at ? localHHMM(task.due_at, timezone) : ctx.morningTime)
  const dayFrom = task.deadline_at ?? task.due_at
  const defaultDay = dayFrom ? weekdayOf(dayFrom, timezone) : todayWeekday(ctx)
  const rule: RuleDraft = { ...parseRule(`FREQ=WEEKLY;BYDAY=${defaultDay}`)! }
  const base = {
    rule,
    mode: 'from_due' as Mode,
    stop: false,
    refusal: null,
    defaultDay,
    leadDays: task.lead_days ?? null,
  }
  if (!task.deadline_at) {
    return {
      ...base,
      anchor: 'target',
      targetTime: time,
      deadlineTime: null,
      daysBefore: 0,
      targetSlotId: null,
    }
  }
  const deadlineTime = localHHMM(task.deadline_at, timezone)
  const fields = ruleFields(buildRule(rule, deadlineTime), 'from_due')
  const walk = memoWalk(fields, task.deadline_at, timezone)
  // A RELATIVE one-off (2026-10-24) keeps its own offsets and link — never
  // read back from its target, which the deadline may have clamped.
  const stored = relativeOf(task)
  let offset: RelativeTarget | null =
    stored ?? (task.due_at ? relativeTargetOf(task.due_at, task.deadline_at, timezone) : null)
  let slotId = stored ? (task.target_slot_id ?? null) : null
  if (offset && relativeTargetProblem(offset, fields, task.deadline_at, timezone, walk)) {
    offset = null
    slotId = null
  }
  // L1 (2026-10-22): with the deadlines page, no default — no fake target.
  if (!offset && ctx.leads) {
    return {
      ...base,
      anchor: 'deadline',
      deadlineTime,
      targetTime: deadlineTime,
      daysBefore: 0,
      targetSlotId: null,
      noTarget: true,
    }
  }
  if (!offset) {
    offset = defaultRelativeTarget(fields, task.deadline_at, timezone, ctx.morningTime, walk)
    // Ruling 10: a default at "Default task time" copies its link.
    slotId = offset.time === ctx.morningTime ? (ctx.morningSlotId ?? null) : null
  }
  return {
    ...base,
    anchor: 'deadline',
    deadlineTime,
    targetTime: offset.time,
    daysBefore: offset.days_before,
    targetSlotId: slotId,
  }
}

/**
 * The stand-in task create mode reads (§8): a one-off with the panel's
 * staged target and deadline, so the draft, the patch and the checks run the
 * same code as an edit.
 */
export function createModeTask(staged: {
  dueAt?: string | null
  deadlineAt?: string | null
  /** A relative target staged with the deadline (2026-10-24): kept by "Make it repeat". */
  relative?: { days: number; time: string; slot_id: number | null } | null
}): EveryTimeTask {
  const relative = staged.deadlineAt ? (staged.relative ?? null) : null
  return {
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    deadline_at: staged.deadlineAt ?? null,
    due_at: staged.dueAt ?? null,
    occurrence_at: null,
    repeat_anchor: null,
    target_days_before: relative?.days ?? null,
    target_time: relative?.time ?? null,
    target_slot_id: relative?.slot_id ?? null,
    on_deck_day: null,
  }
}

/**
 * Whether every-time mode can edit the task's schedule: no rule yet, or one
 * the draft holds part for part (`ruleDraftable`). Otherwise the mode shows
 * the rule read-only — "This repeat can't be edited here" — with Stop
 * repeating only, and nothing ever rebuilds it.
 */
export function scheduleEditable(task: Pick<EveryTimeTask, 'rrule'>): boolean {
  return !task.rrule || ruleDraftable(task.rrule)
}

/** Two drafts that save the same thing (the panel's dirty test). `refusal` is not compared. */
export function draftsEqual(a: EveryTimeDraft, b: EveryTimeDraft): boolean {
  const key = (d: EveryTimeDraft) =>
    JSON.stringify({ ...d, refusal: null, targetSlotId: d.targetSlotId ?? null })
  return key(a) === key(b)
}

// ===========================================================================
// The reducer (§4.3)
// ===========================================================================

export type DraftAction =
  | { type: 'freq'; freq: RuleFrequency }
  | { type: 'interval'; interval: number }
  | { type: 'toggleDay'; day: string }
  | { type: 'monthDay'; day: number | 'last' }
  | { type: 'ends'; endType: RuleDraft['endType']; endCount?: number; endDate?: string }
  | { type: 'mode'; mode: Mode }
  /** The target's time — a period's start with `slotId` (linked), else a custom time. */
  | { type: 'targetTime'; time: string; slotId?: number | null }
  | { type: 'deadlineTime'; time: string }
  | { type: 'daysBefore'; days: number }
  /** The series' lead override (null: the default). */
  | { type: 'leadDays'; days: number | null }
  /** "Repeats on" — to Deadline it is "+ Add" at the target's own time. */
  | { type: 'anchor'; anchor: RepeatAnchor; ctx: EveryTimeContext }
  /** "+ Add" a deadline at `time` to a target-anchored draft (A2). */
  | { type: 'addDeadline'; time: string; ctx: EveryTimeContext }
  /** The Deadline row's "Remove" — the same as Repeats on → Target (A3). */
  | { type: 'removeDeadline'; ctx: EveryTimeContext }
  | { type: 'stop'; stop: boolean }
  | { type: 'reset'; draft: EveryTimeDraft }

export const ADD_DEADLINE_REFUSAL = (targetTime: string) =>
  `Pick a deadline at or after ${hhmmWords(targetTime)}, or change How often first.`
export const LEAVE_DEADLINE_REFUSAL =
  "This rule's targets can't be written as their own days — change How often first."

/**
 * The transitions. Pure; the panel wraps it for `useReducer`. While "Stop
 * repeating" is staged every row is greyed: only `stop` and `reset` act.
 */
export function draftReducer(draft: EveryTimeDraft, action: DraftAction): EveryTimeDraft {
  if (action.type === 'reset') return action.draft
  if (action.type === 'stop') return { ...draft, stop: action.stop, refusal: null }
  if (draft.stop) return draft
  const d = { ...draft, refusal: null }
  return ruleAction(d, action) ?? scheduleAction(d, action)
}

/** How often, the days, the end, Schedule from; null for any other action. */
function ruleAction(d: EveryTimeDraft, action: DraftAction): EveryTimeDraft | null {
  const rule = d.rule
  switch (action.type) {
    case 'freq': {
      // Weekly with no day picks up the task's own (the picker's rule).
      const days = action.freq === 'WEEKLY' && rule.days.length === 0 ? [d.defaultDay] : rule.days
      return { ...d, rule: { ...rule, freq: action.freq, days } }
    }
    case 'interval':
      return { ...d, rule: { ...rule, interval: Math.max(1, Math.floor(action.interval) || 1) } }
    case 'toggleDay': {
      const has = rule.days.includes(action.day)
      const days = has ? rule.days.filter((x) => x !== action.day) : [...rule.days, action.day]
      return { ...d, rule: { ...rule, days } }
    }
    case 'monthDay':
      return { ...d, rule: { ...rule, monthDay: action.day, monthWeekday: null } }
    case 'ends': {
      const endCount = action.endCount ?? rule.endCount
      const endDate = action.endDate ?? rule.endDate
      return { ...d, rule: { ...rule, endType: action.endType, endCount, endDate } }
    }
    case 'mode': {
      // Back to a fixed schedule: a weekly rule with no day picks up the task's own.
      const back = action.mode === 'from_due' && rule.freq === 'WEEKLY' && !rule.days.length
      return { ...d, mode: action.mode, rule: back ? { ...rule, days: [d.defaultDay] } : rule }
    }
    default:
      return null
  }
}

/** The times, the days before, and the anchor (§4.3). */
function scheduleAction(d: EveryTimeDraft, action: DraftAction): EveryTimeDraft {
  const deadline = d.anchor === 'deadline'
  switch (action.type) {
    case 'targetTime':
      // Picking a time sets a target (only a draft that had none changes key).
      // A link only on a deadline-anchored draft (a rule's own time has none).
      return {
        ...d,
        targetTime: action.time,
        targetSlotId: deadline ? (action.slotId ?? null) : null,
        ...(d.noTarget ? { noTarget: false } : {}),
      }
    case 'deadlineTime':
      return deadline ? { ...d, deadlineTime: action.time } : d
    case 'leadDays':
      return { ...d, leadDays: action.days }
    case 'daysBefore':
      return deadline
        ? {
            ...d,
            daysBefore: Math.max(0, Math.floor(action.days)),
            ...(d.noTarget ? { noTarget: false } : {}),
          }
        : d
    case 'addDeadline':
      return deadline ? d : addDeadline(d, action.time, action.ctx)
    case 'anchor':
      if (action.anchor === d.anchor) return d
      return action.anchor === 'deadline'
        ? addDeadline(d, d.targetTime, action.ctx)
        : leaveDeadline(d, action.ctx)
    case 'removeDeadline':
      return deadline ? leaveDeadline(d, action.ctx) : d
    default:
      return d
  }
}

/**
 * The rule moved `days` local days and re-timed to `newTime`, proved by
 * walking both (`shiftedRuleHolds`); null when it can't be written.
 */
function shiftedRuleDraft(
  d: EveryTimeDraft,
  fromTime: string,
  days: number,
  newTime: string,
  ctx: EveryTimeContext,
): RuleDraft | null {
  const old = buildRule(d.rule, fromTime)
  const shifted = shiftRuleDays(old, days)
  if (!shifted) return null
  const rrule = setRuleTime(shifted, newTime)
  const from = firstFromNow(old, ctx)
  if (!from) return null
  const day = local(from, ctx.timezone).plus({ days }).toISODate()!
  const newFrom = localMoment(day, newTime, ctx.timezone).toISOString()
  const holds = shiftedRuleHolds(
    ruleFields(old, d.mode),
    from,
    ruleFields(rrule, d.mode),
    newFrom,
    days,
    newTime,
    ctx.timezone,
  )
  if (!holds) return null
  // Keep what the text doesn't carry (the end the user staged).
  const parsed = parseRule(rrule)!
  return { ...parsed, endType: d.rule.endType, endCount: d.rule.endCount, endDate: d.rule.endDate }
}

/**
 * "+ Add" a deadline (A2, RT-3): at or after the target's time, the same day
 * (0 days before — valid by construction); earlier, the NEXT day — the rule's
 * days move +1 and the target is "the day before" at its own time, so it
 * stays exactly where it was (Fri 4 PM, deadline Sat 8 AM). Refused when that
 * shift can't be written.
 */
function addDeadline(d: EveryTimeDraft, time: string, ctx: EveryTimeContext): EveryTimeDraft {
  if (time >= d.targetTime) {
    return { ...d, anchor: 'deadline', deadlineTime: time, daysBefore: 0, targetSlotId: null }
  }
  const rule = shiftedRuleDraft(d, d.targetTime, 1, time, ctx)
  if (!rule) return { ...d, refusal: ADD_DEADLINE_REFUSAL(d.targetTime) }
  return { ...d, rule, anchor: 'deadline', deadlineTime: time, daysBefore: 1, targetSlotId: null }
}

/**
 * Repeats on → Target from a deadline-anchored draft (A3): the rule takes the
 * target's time and, when the target is days before, the target's DAYS
 * (shifted back by `daysBefore`). Refused when that can't be written.
 */
function leaveDeadline(d: EveryTimeDraft, ctx: EveryTimeContext): EveryTimeDraft {
  const target = {
    ...d,
    anchor: 'target' as const,
    deadlineTime: null,
    daysBefore: 0,
    targetSlotId: null,
  }
  if (d.daysBefore === 0) return target
  const rule = shiftedRuleDraft(d, d.deadlineTime ?? d.targetTime, -d.daysBefore, d.targetTime, ctx)
  if (!rule) return { ...d, refusal: LEAVE_DEADLINE_REFUSAL }
  return { ...target, rule }
}

// ===========================================================================
// draftToPatch (§5)
// ===========================================================================

/**
 * The rule the task has now, as the draft would write it — so a rule the
 * user didn't change is never re-sent because the editor writes its parts in
 * another order (a target-anchored rule change re-dates the target).
 */
function storedRuleText(task: EveryTimeTask): string | null {
  if (!task.rrule) return null
  const { hour, minute } = ruleTimeOfDay(task.rrule, task.anchor_time)
  return buildRule(parseRule(task.rrule)!, toHHMM(hour, minute))
}

/**
 * The first deadline of a schedule becoming deadline-anchored (§5.3): THIS
 * occurrence's local day plus the target's days before, at the deadline time
 * — so this occurrence's target stays on its day — then the rule's first
 * occurrence on or after it (the same instant when it is on the rule). With
 * no date to start from, the rule's first occurrence from now.
 */
export function firstDeadlineFor(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  const rrule = draftRule(draft)
  const day = task.occurrence_at ?? task.due_at
  if (!day || !draft.deadlineTime) return firstFromNow(rrule, ctx)
  const date = deadlineDateFrom(day, draft.daysBefore, ctx.timezone)
  const candidate = localMoment(date, draft.deadlineTime, ctx.timezone)
  if (draft.mode === 'from_completion') return candidate.toISOString()
  const justBefore = new Date(candidate.getTime() - 1)
  try {
    return computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: null,
      timezone: ctx.timezone,
      completedAt: justBefore,
      prevDueAt: justBefore,
      anchorAt: candidate,
    }).toISOString()
  } catch {
    return null
  }
}

/**
 * EXACTLY WHAT ONE SAVE SENDS (§5), only the fields that change:
 *  - §5.1 target-anchored stays: `rrule` / `recurrence_mode` when changed;
 *  - §5.2 deadline-anchored stays: `rrule` (at the deadline's time) when
 *    changed; the offsets both-or-neither, when either changed; NEVER
 *    `deadline_at` (it would reschedule this occurrence);
 *  - §5.3 becoming deadline-anchored: `repeat_anchor`, `rrule`, the offsets,
 *    and `deadline_at` = the first deadline (`firstDeadlineFor`) — except a
 *    one-off whose own deadline starts the schedule (sent only when the
 *    draft moved its time, so the rule's time matches it);
 *  - §5.4 deadline → target: `repeat_anchor`, `rrule` (the server clears the
 *    deadline); a one-off with a deadline made target-anchored also sends
 *    `deadline_at: null` (a target-anchored repeat has none, L9);
 *  - §5.5 stop: `rrule: null`.
 */
export function draftToPatch(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): EveryTimePatch {
  if (draft.stop) return task.rrule ? { rrule: null } : {}
  // A rule the draft can't hold is never rebuilt (only Stop repeating).
  if (!scheduleEditable(task)) return {}
  const patch: EveryTimePatch = endPatch(task, draft)
  const rrule = draftRule(draft)
  const wasDeadline = isDeadlineAnchored(task)
  const switching = !!task.rrule && wasDeadline !== (draft.anchor === 'deadline')
  if (switching || !task.rrule || rrule !== storedRuleText(task)) patch.rrule = rrule
  if (draft.mode !== storedMode(task)) patch.recurrence_mode = draft.mode
  // The series' lead override (the deadlines page, or Upcoming's Later):
  // only when it changed — or back to the default when the rule makes it
  // too long (`leadResetForRule`; never a 400).
  const lead = leadResetForRule(task, draft, ctx) ? null : draft.leadDays
  if (lead !== undefined && lead !== (task.lead_days ?? null)) patch.lead_days = lead
  if (draft.anchor === 'target') {
    if (switching) patch.repeat_anchor = 'target'
    // A field, not SQL: written as a spread so the SQL-writer guards (UP-090) don't read it as one.
    return !task.rrule && task.deadline_at ? { ...patch, deadline_at: null } : patch
  }
  return { ...patch, ...deadlinePatch(task, draft, ctx) }
}

/**
 * The end fields a Save sends — only when the end changed. Setting one end
 * clears the other on the server (`resultingEnd`), so one field is enough;
 * back to Never sends the stored one as null.
 */
function endPatch(task: EveryTimeTask, draft: EveryTimeDraft): EveryTimePatch {
  // "On date…" chosen with no date yet is no change — never a removal of the
  // stored end (a host's save-and-leave could otherwise send it).
  if (draft.rule.endType === 'date' && !draft.rule.endDate) return {}
  const { count, until } = draftEnd(draft)
  const stored = repeatEndOf(task)
  if (count === stored.repeat_count && until === stored.repeat_until) return {}
  if (count !== null) return { repeat_count: count }
  if (until !== null) return { repeat_until: until }
  return stored.repeat_count !== null ? { repeat_count: null } : { repeat_until: null }
}

/** The deadline-anchored half of `draftToPatch`: the offsets, and the switch's own fields. */
function deadlinePatch(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): EveryTimePatch {
  const patch: EveryTimePatch = {}
  const wasDeadline = isDeadlineAnchored(task)
  const slotId = draft.targetSlotId ?? null
  const offsetsChanged =
    !draft.noTarget &&
    (!wasDeadline ||
      draft.daysBefore !== task.target_days_before ||
      draft.targetTime !== task.target_time ||
      slotId !== (task.target_slot_id ?? null))
  if (offsetsChanged) {
    patch.target_days_before = draft.daysBefore
    // Linked: the period alone (the server sets the time to its start);
    // custom: the time alone, which drops a stored link.
    if (slotId !== null) patch.target_slot_id = slotId
    else patch.target_time = draft.targetTime
  }
  if (wasDeadline) return patch
  patch.repeat_anchor = 'deadline'
  if (!task.rrule && task.deadline_at) {
    // A one-off's own deadline starts the schedule (A3/L9); re-timed if moved.
    if (draft.deadlineTime && draft.deadlineTime !== localHHMM(task.deadline_at, ctx.timezone)) {
      const day = local(task.deadline_at, ctx.timezone).toISODate()!
      patch.deadline_at = localMoment(day, draft.deadlineTime, ctx.timezone).toISOString()
    }
    return patch
  }
  const first = firstDeadlineFor(task, draft, ctx)
  if (first) patch.deadline_at = first
  return patch
}

/**
 * The fields a CREATE sends for a staged every-time draft (§8): the patch,
 * minus what a new row has no use for. A deadline-anchored create always
 * carries its first deadline; never `due_at` (the offsets win) and never a
 * deck (a repeating create on deck is refused).
 */
export function draftToCreateFields(
  staged: Parameters<typeof createModeTask>[0],
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): EveryTimePatch {
  const task = createModeTask(staged)
  const patch = draftToPatch(task, draft, ctx)
  if (patch.deadline_at === null) delete patch.deadline_at
  if (draft.anchor === 'deadline' && patch.deadline_at === undefined) {
    patch.deadline_at = staged.deadlineAt ?? firstDeadlineFor(task, draft, ctx) ?? undefined
  }
  return patch
}

// ===========================================================================
// draftProblem (§6)
// ===========================================================================

export const NO_END_DATE_PROBLEM = 'Pick the date it ends on.'
export const NO_DAY_PROBLEM = 'Pick at least one day.'
export const NO_DEADLINE_TIME_PROBLEM = 'Pick a deadline time.'
export const NEVER_OCCURS_PROBLEM = 'This repeat never comes round — check its days and months.'

/**
 * The server's refusal in the panel's words (§6.2). The messages that need a
 * request the editor never builds (`RULE_NOT_ON_DEADLINE_MESSAGE`,
 * `TARGET_ANCHORED_DEADLINE_MESSAGE`, …) pass through as they are — a test
 * asserts no valid draft reaches one.
 */
export function problemWords(message: string, draft: EveryTimeDraft): string {
  const known: Record<string, string> = {
    [RELATIVE_TARGET_MESSAGES.after_deadline]: `On the deadline day the target must be at or before ${hhmmWords(draft.deadlineTime ?? draft.targetTime)}.`,
    [RELATIVE_TARGET_MESSAGES.overlaps_previous]:
      "That's on or before the previous deadline — fewer days before for this rule.",
    [NEVER_OCCURS_MESSAGE]: NEVER_OCCURS_PROBLEM,
    [TARGET_AFTER_DEADLINE_MESSAGE]: 'The target must not be after the deadline.',
  }
  return known[message] ?? message
}

/** The planner's context for an ordinary task (every-time mode never edits a reminder or quota). */
function planContext(ctx: EveryTimeContext) {
  return { ...ctx, isReminder: false, isTracked: false }
}

type Planned = { plan: RepeatPlan; patch: EveryTimePatch } | { error: string }

const PLAN_CACHE_SIZE = 8
const planCache = new Map<string, Planned>()

/**
 * The planner's answer for the draft, or the refusal it throws. Memoised on
 * (task, patch, context): the planner walks the rule (up to 61 occurrences)
 * and one draft change asks it from `draftProblem`, `nextDates`,
 * `daysBeforeChoices` and `thisOneHint` alike (RT-9). A small LRU; the
 * result is never mutated by its readers.
 */
function planDraft(task: EveryTimeTask, draft: EveryTimeDraft, ctx: EveryTimeContext): Planned {
  const patch = draftToPatch(task, draft, ctx)
  const key = JSON.stringify([
    task,
    patch,
    ctx.timezone,
    ctx.morningTime,
    ctx.dayStart,
    ctx.now.getTime(),
  ])
  const hit = planCache.get(key)
  if (hit) {
    planCache.delete(key)
    planCache.set(key, hit)
    return hit
  }
  let planned: Planned
  try {
    planned = { plan: planRepeatSchedule(task, patch as ScheduleInput, planContext(ctx)), patch }
  } catch (e) {
    planned = { error: e instanceof Error ? e.message : String(e) }
  }
  planCache.set(key, planned)
  if (planCache.size > PLAN_CACHE_SIZE) planCache.delete(planCache.keys().next().value!)
  return planned
}

/**
 * Why Save is disabled, or null (§6). Local checks first (a weekly rule with
 * no day, an end, a missing deadline time), then the route's rule validation
 * (`isValidRRule`), then the server's planner on the exact patch — a
 * refusal there is the 400 the Save would get, in the panel's words. A
 * target-anchored rule must also have a next occurrence.
 */
export function draftProblem(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  if (draft.stop) return null
  if (weeklyDayMissing(draft.rule, draft.mode)) return NO_DAY_PROBLEM
  if (draft.rule.endType === 'date' && !draft.rule.endDate) return NO_END_DATE_PROBLEM
  if (draft.anchor === 'deadline' && !draft.deadlineTime) return NO_DEADLINE_TIME_PROBLEM
  const rrule = draftRule(draft)
  if (!isValidRRule(rrule)) {
    return draft.rule.freq === 'WEEKLY' && !draft.rule.days.length
      ? NO_DAY_PROBLEM
      : NEVER_OCCURS_PROBLEM
  }
  const planned = planDraft(task, draft, ctx)
  if ('error' in planned) return problemWords(planned.error, draft)
  if (draft.anchor === 'target' && !firstFromNow(rrule, ctx)) return NEVER_OCCURS_PROBLEM
  const end = endProblem(task, draft, ctx, planned)
  return end ? endProblemWords(end, task) : null
}

/** The used count a Save leaves: a count set where there was none starts at 0 (A3). */
function usedAfter(task: EveryTimeTask, draft: EveryTimeDraft): number {
  const stored = repeatEndOf(task)
  const { count } = draftEnd(draft)
  return count !== null && stored.repeat_count === null ? 0 : stored.repeat_count_used
}

const WALK_FIELDS = ['rrule', 'recurrence_mode', 'repeat_anchor'] as const

/**
 * The occurrence a Save leaves (what an end must not be before): the
 * planner's on a deadline-anchored result; a target-anchored rule left as it
 * is keeps its own; a changed one starts from its first (`scheduleStart`).
 */
function occurrenceLeft(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
  planned: { plan: RepeatPlan; patch: EveryTimePatch },
): string | null {
  if (planned.plan.kind === 'deadline') return planned.plan.occurrenceAt
  const walked = WALK_FIELDS.some((f) => f in planned.patch)
  if (task.rrule && !walked) return task.occurrence_at ?? task.due_at
  return scheduleStart(task, draft, ctx)
}

/**
 * The server's own end check on the draft (`repeatEndProblem`, which the
 * PATCH runs in `collectRepeatEnds` — the planner doesn't), with the same
 * "written = changed" reading, so an end the user didn't touch is never
 * re-judged.
 */
function endProblem(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
  planned: { plan: RepeatPlan; patch: EveryTimePatch },
): RepeatEndProblem | null {
  const { count, until } = draftEnd(draft)
  const stored = repeatEndOf(task)
  const patch = planned.patch
  return repeatEndProblem(
    {
      count,
      until,
      used: usedAfter(task, draft),
      countWritten: 'repeat_count' in patch && count !== stored.repeat_count,
      untilWritten: 'repeat_until' in patch && until !== stored.repeat_until,
      walkWritten: WALK_FIELDS.some((f) => f in patch),
      occurrenceAt: occurrenceLeft(task, draft, ctx, planned),
      hasRule: true,
      isReminder: false,
      isTracked: false,
    },
    ctx.timezone,
    ctx.now,
    ctx.dayStart,
  )
}

/** The end refusals in the panel's words (the server's own text for the rest). */
export function endProblemWords(problem: RepeatEndProblem, task: EveryTimeTask): string {
  const used = repeatEndOf(task).repeat_count_used
  const times = used === 1 ? 'time' : 'times'
  const words: Partial<Record<RepeatEndProblem, string>> = {
    count_range: 'Pick from 1 to 999 times.',
    count_spent: `It has already come round ${used} ${times} — pick more than ${used}.`,
    until_invalid: NO_END_DATE_PROBLEM,
    until_past: 'That end date has passed.',
    until_too_far: 'Pick an end date within 10 years.',
    until_before_occurrence: "That's before this one's date — pick a later end.",
  }
  return words[problem] ?? REPEAT_END_MESSAGES[problem]
}

// ===========================================================================
// The walk, Next, and the greyed choices (§6)
// ===========================================================================

const WALK_CACHE_SIZE = 8
const walkCache = new Map<string, Date[]>()

/**
 * `deadlineWalk`, memoised on (rule, mode, first, zone): up to 61
 * `computeNextOccurrence` calls, asked by Next and by every days-before
 * choice on each draft change (RT-9). A small LRU.
 */
export function memoWalk(rule: RepeatRule, first: string, timezone: string): Date[] {
  const key = [rule.rrule, rule.recurrence_mode, rule.anchor_time, first, timezone].join('|')
  const hit = walkCache.get(key)
  if (hit) {
    walkCache.delete(key)
    walkCache.set(key, hit)
    return hit
  }
  const walk = deadlineWalk(rule, first, timezone)
  walkCache.set(key, walk)
  if (walkCache.size > WALK_CACHE_SIZE) walkCache.delete(walkCache.keys().next().value!)
  return walk
}

/**
 * The schedule's next occurrence as the Save would leave it — where Next and
 * the greyed choices start:
 *  - deadline-anchored: the planner's `occurrenceAt` (it already holds the
 *    over-target "keep the day" branch, RT-8);
 *  - target-anchored with the rule unchanged: the next on the task's own
 *    grid after now; changed: the rule's first from now (what the server
 *    writes, `collectRruleChanges`).
 */
export function scheduleStart(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  if (draft.stop) return null
  const rrule = draftRule(draft)
  if (draft.anchor === 'deadline') return deadlineStart(task, draft, ctx)
  const unchanged = task.rrule && !isDeadlineAnchored(task) && rrule === storedRuleText(task)
  if (!unchanged || !task.occurrence_at || draft.mode !== 'from_due')
    return firstFromNow(rrule, ctx)
  try {
    return computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: null,
      timezone: ctx.timezone,
      completedAt: ctx.now,
      prevDueAt: null,
      anchorAt: new Date(task.occurrence_at),
    }).toISOString()
  } catch {
    return null
  }
}

/**
 * A deadline-anchored draft's first deadline — the occurrence the planner
 * leaves. It never depends on the offsets (`occurrenceFor` runs before them),
 * so for a task that stays deadline-anchored the planner is asked with the
 * deadline's own time as the target (always valid): the greyed days-before
 * choices need it even while the draft's own offsets are refused. Becoming
 * deadline-anchored, it is the deadline the patch sends (or the one-off's own).
 */
function deadlineStart(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  if (!draft.deadlineTime) return null
  if (isDeadlineAnchored(task)) {
    // The draft's own plan when it has one (memoised — `draftProblem` just
    // asked it); the safe offsets only when the draft's own are refused.
    const own = planDraft(task, draft, ctx)
    if (!('error' in own) && own.plan.kind === 'deadline') return own.plan.occurrenceAt
    const safe = { ...draft, daysBefore: 0, targetTime: draft.deadlineTime }
    const planned = planDraft(task, safe, ctx)
    if ('error' in planned || planned.plan.kind !== 'deadline') return null
    return planned.plan.occurrenceAt
  }
  if (!task.rrule && task.deadline_at) {
    const day = local(task.deadline_at, ctx.timezone).toISODate()!
    return localMoment(day, draft.deadlineTime, ctx.timezone).toISOString()
  }
  return firstDeadlineFor(task, draft, ctx)
}

export interface NextDate {
  /** Null on a deadline-anchored schedule with no relative target (L1). */
  targetAt: string | null
  /** Null on a target-anchored schedule. */
  deadlineAt: string | null
  /** The series ends with this one (its end, judged by `repeatStep`). */
  last: boolean
}

export interface NextDates {
  dates: NextDate[]
  /** Fewer than asked: the rule runs out (· ends). */
  ends: boolean
  /** Why there are none (the draft's problem, or "Ends before its next date"). */
  problem: string | null
}

export const ENDS_BEFORE_NEXT = 'Ends before its next date'

/**
 * NEXT: the schedule's next `count` occurrences (§6) — each its deadline and
 * target on a deadline-anchored draft (`nextDateWords` says them).
 * From_completion reads "if done on time": each walked as done on its own
 * date. This occurrence is the hint's, not Next's.
 */
export function nextDates(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
  count = 3,
): NextDates {
  if (draft.stop) return { dates: [], ends: true, problem: null }
  const problem = draftProblem(task, draft, ctx)
  if (problem) return { dates: [], ends: true, problem }
  const first = scheduleStart(task, draft, ctx)
  if (!first) return { dates: [], ends: true, problem: ENDS_BEFORE_NEXT }
  const rrule = draftRule(draft)
  const walk = memoWalk(ruleFields(rrule, draft.mode), first, ctx.timezone)
  const schedule = {
    rrule,
    repeat_anchor: draft.anchor,
    target_days_before: draft.noTarget ? null : draft.daysBefore,
    target_time: draft.noTarget ? null : draft.targetTime,
  }
  const dates = walkInSeries(task, draft, first, walk, count, ctx).map(({ at, last }) => {
    const o = occurrenceDates(schedule, at, ctx.timezone)
    return { targetAt: o.targetAt, deadlineAt: o.deadlineAt, last }
  })
  const cut = dates.some((d) => d.last)
  return { dates, ends: cut || dates.length < count, problem: null }
}

/**
 * The walk cut by the series' end — the server's judge, `repeatStep`, asked
 * as each advance asks it: landing on `walk[i]` closes `i` occurrences (one
 * more when the walk starts after the current occurrence — an over-target
 * one still open). The first landing that ENDS the series makes the one
 * before it the last. Up to `count` occurrences.
 */
function walkInSeries(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  first: string,
  walk: Date[],
  count: number,
  ctx: EveryTimeContext,
): Array<{ at: string; last: boolean }> {
  const timezone = ctx.timezone
  const { count: total, until } = draftEnd(draft)
  const end = {
    repeat_count: total,
    repeat_count_used: usedAfter(task, draft),
    repeat_until: until,
  }
  // The walk starts AFTER the current occurrence only when the schedule is
  // left as it is and that one is still open over target: Next then begins
  // with the next after now (`scheduleStart`). A changed schedule replaces
  // the current occurrence with its first (the server writes it).
  const walked = WALK_FIELDS.some((f) => f in draftToPatch(task, draft, ctx))
  const current = task.rrule && !walked ? task.occurrence_at : null
  const now = ctx.now.getTime()
  const before =
    current &&
    Date.parse(current) < now &&
    Date.parse(first) > now &&
    local(current, timezone).toISODate() !== local(first, timezone).toISODate()
      ? 1
      : 0
  const kept: Array<{ at: string; last: boolean }> = []
  for (let i = 0; i <= count; i++) {
    const landing = walk[i] ? walk[i].toISOString() : null
    const step = repeatStep(end, landing, i + before, timezone)
    if (step.ended) {
      if (kept.length > 0) kept[kept.length - 1].last = true
      break
    }
    if (i < count) kept.push({ at: step.occurrenceAt, last: false })
  }
  return kept
}

/**
 * One occurrence, in words, for a Next line and the hint (2026-10-24: one
 * occurrence per line, every date labelled and timed — the old
 * "Fri Nov 6 → Sat Nov 7" arrow meant nothing and had no times):
 *  - deadline-anchored: the occurrence is its deadline's day —
 *    "Sat Nov 7 · deadline 8:00 AM · target Fri 12:00 PM" (`targetWhen`
 *    says the target's day only as plainly as is unambiguous);
 *  - no target of its own (L1, the deadlines page): "Sat Nov 7 · deadline 8:00 AM";
 *  - target-anchored: "Sat Nov 7 · 9:00 AM".
 * "· last one" when the series ends with it.
 */
export function nextDateWords(date: NextDate, timezone: string): string {
  const last = date.last ? ' · last one' : ''
  if (date.deadlineAt) {
    const deadline = local(date.deadlineAt, timezone)
    const head = `${deadline.toFormat('ccc LLL d')} · deadline ${deadline.toFormat('h:mm a')}`
    if (date.targetAt === null) return `${head}${last}`
    return `${head} · target ${targetWhen(local(date.targetAt, timezone), deadline)}${last}`
  }
  if (date.targetAt === null) return ''
  return `${local(date.targetAt, timezone).toFormat('ccc LLL d · h:mm a')}${last}`
}

/**
 * A deadline-anchored occurrence's target, said against its deadline (the
 * line already gives the deadline's date): the same day — the time alone;
 * within the week before it, in the same month — the weekday ("Fri 12:00 PM",
 * there is only one Friday it can be); further off, across a month, or after
 * the deadline (a moved target) — the full date ("Thu Oct 29 12:00 PM").
 * Calendar days in the zone, never 24-hour spans: a DST change makes a
 * 23- or 25-hour day.
 */
function targetWhen(target: DateTime, deadline: DateTime): string {
  const time = target.toFormat('h:mm a')
  const days = Math.round(deadline.startOf('day').diff(target.startOf('day'), 'days').days)
  if (days === 0) return time
  if (days > 0 && days < 7 && target.hasSame(deadline, 'month')) {
    return `${target.toFormat('ccc')} ${time}`
  }
  return `${target.toFormat('ccc LLL d')} ${time}`
}

export interface DaysBeforeChoice {
  days: number
  /** Why the server would refuse it (greyed, with the reason), else null. */
  refused: RelativeTargetProblem | null
}

/**
 * The "days before" select's choices 0..`max` (§6, plan §8), each greyed when
 * `relativeTargetProblem` refuses it — ONE walk for all of them. Empty on a
 * target-anchored draft.
 */
export function daysBeforeChoices(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
  max = 7,
): DaysBeforeChoice[] {
  if (draft.anchor !== 'deadline' || !draft.deadlineTime || draft.stop) return []
  const rule = ruleFields(draftRule(draft), draft.mode)
  const first = deadlineStart(task, draft, ctx)
  if (!first) return []
  const walk = memoWalk(rule, first, ctx.timezone)
  return Array.from({ length: max + 1 }, (_, days) => ({
    days,
    refused: relativeTargetProblem(
      { days_before: days, time: draft.targetTime },
      rule,
      first,
      ctx.timezone,
      walk,
    ),
  }))
}

/** The Target time select greys later times than the deadline's on the deadline day itself. */
export function targetTimeRefused(draft: EveryTimeDraft, time: string): boolean {
  return (
    draft.anchor === 'deadline' &&
    draft.daysBefore === 0 &&
    !!draft.deadlineTime &&
    time > draft.deadlineTime
  )
}

// ===========================================================================
// The hint (§5.6)
// ===========================================================================

/**
 * Whether THIS occurrence has something of its own a schedule change keeps:
 * a deck, or a target the USER moved — the server's own rule,
 * `occurrenceIsPersonal` (src/lib/task-segments.ts, PR 4a), which the
 * writers keep it by. A QUEUED repeat is not personal (the rollover moved
 * its target, not the user). An arrived target (over target) is not either:
 * the server's debt branch keeps it on a RULE change only — `thisOneHint`
 * asks the planner for that case.
 */
export function occurrenceKeepsItsOwn(task: EveryTimeTask, ctx: EveryTimeContext): boolean {
  return occurrenceIsPersonal(task, ctx.timezone) !== null
}

/**
 * The target THIS occurrence gets from the Save, as the server writes it: a
 * deadline-anchored result's planned target (`dueAt`, undefined: unchanged);
 * a target-anchored one's rule changed — its first occurrence from now
 * (`collectRruleChanges`), unless its target has arrived (kept, the debt);
 * the rule unchanged — its target as it is.
 */
function thisOneTarget(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  const planned = planDraft(task, draft, ctx)
  if ('error' in planned) return task.due_at
  if (planned.plan.kind === 'deadline') return planned.plan.dueAt ?? task.due_at
  // An arrived target is kept (the debt); a target-anchored result has no deadline to cap at.
  const arrived = task.due_at !== null && Date.parse(task.due_at) < ctx.now.getTime()
  if (planned.patch.rrule && !arrived) return firstFromNow(planned.patch.rrule, ctx) ?? task.due_at
  return task.due_at
}

export const KEEPS_ITS_OWN_TARGET =
  'Changes apply to every future occurrence. This one keeps its own target.'
export const KEEPS_ITS_DECK = 'Changes apply to every future occurrence. This one stays on deck.'

/**
 * THE HINT under every-time mode (§5.6), three branches:
 *  - "Stop repeating" staged: what this one stays as — a one-time task with
 *    its target (or deck) and its deadline;
 *  - this occurrence has something of its own (`occurrenceKeepsItsOwn`):
 *    changes apply to future occurrences, this one keeps it — TRUE once the
 *    server keeps a moved target and a deck across a schedule change (PR 4a);
 *  - on schedule: changes apply starting with this one, at the dates the
 *    Save gives it, in a Next line's words (`nextDateWords`).
 * Null in create mode (nothing exists yet; Next says when it starts).
 */
export function thisOneHint(
  task: EveryTimeTask | null,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  if (!task) return null
  const tz = ctx.timezone
  if (draft.stop) {
    const what = task.due_at
      ? `target ${whenWords(task.due_at, tz)}`
      : task.on_deck_day
        ? 'on deck'
        : 'no target'
    const deadline = task.deadline_at ? `, deadline ${whenWords(task.deadline_at, tz)}` : ''
    // Ruling 6 (2026-10-24): an unmoved relative target is kept — it goes on
    // moving with the deadline (the server's `stopKeepsRelative`).
    const relative = stopKeepsRelativeTarget(task, tz)
    const keeps = relative
      ? ` The target stays ${relativeDaysWords(relative.days_before)} and moves with the deadline.`
      : ''
    return `This one stays as a one-time task: ${what}${deadline}.${keeps}`
  }
  // A one-off with a deadline made target-anchored: a target-anchored repeat
  // has no deadline (L9), so the Save removes it — said before Save.
  if (!task.rrule && task.deadline_at && draft.anchor === 'target') {
    const day = local(task.deadline_at, tz).toFormat('ccc LLL d')
    return `The deadline (${day}) will be removed.`
  }
  if (occurrenceKeepsItsOwn(task, ctx)) {
    return task.on_deck_day ? KEEPS_ITS_DECK : KEEPS_ITS_OWN_TARGET
  }
  const at = thisOneTarget(task, draft, ctx)
  const deadlineAt = thisOneDeadline(task, draft, ctx)
  if (!at && !deadlineAt) return 'Changes apply to every occurrence.'
  // Over target: the server keeps the arrived target on a rule change (the
  // debt) but re-derives it on, say, new offsets — say whichever it does.
  const arrived = task.due_at !== null && Date.parse(task.due_at) < ctx.now.getTime()
  if (arrived && at && Date.parse(at) === Date.parse(task.due_at!)) return KEEPS_ITS_OWN_TARGET
  // The same words as a Next line (`nextDateWords`).
  const words = nextDateWords({ targetAt: at, deadlineAt, last: false }, tz)
  return `Changes apply to every occurrence, starting with this one: ${words}.`
}

/**
 * STOP REPEATING keeps the relative target (ruling 6, 2026-10-24) — the
 * server's `stopKeepsRelative` (src/core/tasks/relative-target.ts), read on
 * the stored row: a deadline-anchored repeat with a relative target and a
 * target, not on deck, whose target wasn't moved this occurrence. The offsets
 * it keeps, else null.
 */
export function stopKeepsRelativeTarget(
  task: EveryTimeTask,
  timezone: string,
): RelativeTarget | null {
  if (!task.rrule || !isDeadlineAnchored(task) || !task.due_at || task.on_deck_day) return null
  const relative = relativeOf(task)
  if (!relative || !task.deadline_at) return null
  return targetMoved(task, timezone) ? null : relative
}

/**
 * The deadline THIS occurrence gets from the Save: a deadline-anchored
 * result's planned occurrence (its deadline); none on a target-anchored one
 * (L9). Unplanned (a refused draft), the stored one while the draft keeps
 * the deadline anchor.
 */
function thisOneDeadline(
  task: EveryTimeTask,
  draft: EveryTimeDraft,
  ctx: EveryTimeContext,
): string | null {
  if (draft.anchor !== 'deadline') return null
  const planned = planDraft(task, draft, ctx)
  if (!('error' in planned) && planned.plan.kind === 'deadline') return planned.plan.occurrenceAt
  return task.deadline_at
}

// ===========================================================================
// Bulk (A11, §9)
// ===========================================================================

export const BULK_DEADLINE_REASON = 'Some of these have deadlines — edit them one at a time.'
export const BULK_KIND_REASON = 'Reminders and quotas keep their own schedules.'

/**
 * Whether the action bar's More sheet offers every-time mode for a selection
 * of several tasks (A11): only when EVERY task is an ordinary one-off with no
 * deadline or a target-anchored repeat — a deadline anywhere would make
 * bulk/edit refuse the whole batch (L9). Otherwise the link is disabled with
 * the reason. In bulk mode Repeats on is fixed to Target and there is no
 * Deadline row (`draftToBulkChanges`).
 */
export function bulkEveryTimeGate(
  tasks: Array<
    Pick<Task, 'rrule' | 'repeat_anchor' | 'deadline_at'> & {
      is_reminder?: boolean
      is_tracked?: boolean
      progress_target?: number
    }
  >,
): { offered: boolean; reason: string | null } {
  const kind = tasks.some((t) => t.is_reminder || t.is_tracked || (t.progress_target ?? 1) > 1)
  if (kind) return { offered: false, reason: BULK_KIND_REASON }
  const deadline = tasks.some((t) => t.deadline_at !== null || isDeadlineAnchored(t))
  if (deadline) return { offered: false, reason: BULK_DEADLINE_REASON }
  return { offered: true, reason: null }
}

/**
 * A bulk every-time Save's `changes` for bulk/edit (§9): the rule at its
 * target time and the mode, or `rrule: null` for Stop repeating. Never an
 * anchor, a deadline or offsets (`editFields` would drop them anyway).
 */
export function draftToBulkChanges(draft: EveryTimeDraft): {
  rrule: string | null
  recurrence_mode?: Mode
} {
  if (draft.stop) return { rrule: null }
  return { rrule: buildRule(draft.rule, draft.targetTime), recurrence_mode: draft.mode }
}
