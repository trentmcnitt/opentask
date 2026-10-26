/**
 * Field change collection helper for task updates
 *
 * Extracts common logic for tracking field changes, anchor derivation, the
 * target model (§6/§8, 2026-10-12: the stored automatic deadline target, the
 * target ≤ deadline cap, a repeating task's occurrence kept apart from its
 * target) and move detection. Used by both single and bulk edit operations.
 */

import { getDb } from '@/core/db'
import type { Task, TaskUpdateInput } from '@/types'
import { deriveAnchorFields, computeFirstOccurrence, fillRuleTime } from '@/core/recurrence'
import { AppError, NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { DateTime } from 'luxon'
import {
  DECK_WITH_DATE_MESSAGE,
  DECK_WITH_RULE_MESSAGE,
  QUOTA_DUE_DATE_MESSAGE,
  QUOTA_INTERVAL_MESSAGE,
  QUOTA_PERIOD_MESSAGE,
  REMINDER_SNOOZE_MESSAGE,
  TRACKED_REMINDER_MESSAGE,
} from '@/core/validation'
import { isTracked, quotaIntervalAllowed, quotaPeriodOf } from '@/lib/track'
import { loggedSince, quotaAnchorNow, rolloverQuotaNow } from '../period-rollover'
import { getTaskById } from '../read'
import {
  DECK_REFUSAL_MESSAGES,
  REPEATING_DECK_REFUSAL_MESSAGE,
  capAtDeadline,
  deckDayProblem,
  deckRefusal,
  deckSkip,
  hasPickedTarget,
  hasRelativeTarget,
  isDeadlineAnchored,
  leadDaysProblem,
  leadFor,
  occurrenceDates,
  type LeadFields,
  openTaskToday,
  occurrenceDayAtRuleTime,
  occurrenceIsPersonal,
  relativeOf,
  resolveTarget,
  type PersonalOccurrence,
  type RelativeTarget,
  type TargetContext,
} from '@/lib/task-segments'
import {
  assertOneOffRelative,
  linkAfter,
  linkTargetTime,
  stopKeepsRelative,
  type SlotsFor,
} from '../relative-target'
import { getTargetContext } from '../target-context'
import { assertPromptSlotsOwned } from '@/core/time-slots'
import { stampTargetSet } from '../target-set'
import { collectDeckClear, deckKeepsPageRow, deckRolloverTime } from '../deck-clear'
import { taskQueueEnabled } from '../task-queue'
import { dayBoundaryForUser, rolloverTimeForUser } from '../rollover-time'
import {
  REPEAT_END_MESSAGES,
  planRepeatSchedule,
  repeatEndProblem,
  type RepeatPlan,
} from '../repeat-schedule'

/** Extended input type that supports additive/subtractive label operations and origin reset */
export type FieldChangesInput = TaskUpdateInput & {
  labels_add?: string[]
  labels_remove?: string[]
  /** Ignored on a task (§6: a move is a move); a reminder's explicit reschedule. */
  reset_original_due_at?: boolean
  /**
   * Server-internal (never in a request schema): "Target today" marks the task
   * considered in the same write, so one undo entry covers both.
   */
  last_considered_at?: string
  /**
   * Server-internal too: targeting from a task segment (Today, or its time
   * picker) stamps `segment_targeted_at` in the same write, so the Undo of the
   * targeting puts the previous stamp back with the target.
   */
  segment_targeted_at?: string
  /**
   * Server-internal (task queue, 2026-10-19): a DEFER landing at or after the
   * next rollover sets the queue mark in the same write as its target, so one
   * undo entry covers both (`bulkSnooze`). `try_tomorrow` likewise, from Try
   * Tomorrow. Present = this write is the defer, so `stampTargetSet` keeps the
   * mark instead of clearing it.
   */
  queue_mark?: boolean
  try_tomorrow?: boolean
  /**
   * Server-internal (task queue, spec rule 2 "the original target is
   * remembered"): the defer that NEWLY sets the mark also records the task's
   * pre-sweep target here, in the same write and snapshot, so the rollover
   * keeps it (not the rollover moment the sweep moved it to) and undo of the
   * sweep puts the old value back. Omitted by a defer of an already-marked
   * task, which keeps the value its first sweep wrote.
   */
  queued_from_due_at?: string | null
  /**
   * Server-internal (relative targets, 2026-10-24): the period RETIME's write
   * (`src/core/time-slots/edit.ts`) — its `target_time` keeps the link, and
   * the stamp keeps `target_set_at` (decision 11: a retime is not the user
   * setting a target) while still checkpointing attempts.
   */
  retime?: boolean
}

export interface FieldChangeData {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
  beforeState: Partial<Task> & { id: number }
  afterState: Partial<Task> & { id: number }
  /**
   * The user moved a dated task's target to another date (any "snooze", any
   * client — §6, 2026-10-12, one gesture). Counts the snooze stat and words
   * the description "Deferred to …". Not a first date, a clear, a schedule
   * change or a target the server derived (the automatic one).
   */
  isSnoozeScenario: boolean
  /** The requested target was past the deadline and stopped AT it (§8.2). */
  cappedAtDeadline?: boolean
}

export interface CollectFieldChangesOptions {
  task: Task
  input: FieldChangesInput
  userId: number
  userTimezone: string
  /** Current date for overdue detection. Defaults to new Date() */
  now?: Date
  /** Skip project access validation (for bulk operations that validate upfront) */
  skipProjectValidation?: boolean
  /**
   * The owner's clock for an automatic target (`getTargetContext`); a bulk
   * caller passes it once. Read from the task's owner when absent.
   */
  targetCtx?: TargetContext
  /**
   * The owners' reminder periods, for a sent `target_slot_id` (relative
   * targets): a bulk caller passes a memoized lookup, one read per owner.
   */
  slotsFor?: SlotsFor
  /**
   * The owner's rollover time ("Day starts at"), for a re-derived lead day; a
   * caller looping over one owner's rows passes it once. Read when absent.
   */
  rolloverTime?: string
}

/**
 * Helper to track a single field change
 */
function trackField<K extends keyof Task>(
  data: FieldChangeData,
  field: K,
  oldVal: Task[K],
  newVal: Task[K],
  clause: string = `${field} = ?`,
  /**
   * What to bind for this column, when it differs from the domain value.
   * SQLite has no boolean type and better-sqlite3 refuses to bind one, so
   * boolean fields keep their JS type in the undo snapshot (where readers
   * expect a boolean) while binding 0/1 here.
   */
  dbValue: unknown = newVal,
): void {
  data.setClauses.push(clause)
  data.values.push(dbValue)
  data.fieldsChanged.push(field)
  data.beforeState[field] = oldVal
  data.afterState[field] = newVal
}

/**
 * Collect all field changes for a task update
 *
 * Handles:
 * - Basic field tracking (title, priority, labels, etc.)
 * - Project access validation
 * - rrule changes with anchor field derivation
 * - due_at changes with snooze detection
 * - The row invariants every edit path shares, judged on the RESULTING row
 *   (throws ValidationError): a quota has no date and always a period, is
 *   never a reminder, and a reminder is never snoozed. Single PATCH, bulk
 *   edit and period moves all come through here, so none can skip them.
 *
 * Does NOT:
 * - Execute any database writes
 * - Call logAction() for undo
 * - Add updated_at clause (caller adds that)
 *
 * @returns Field change data ready for SQL execution
 */
export function collectFieldChanges(options: CollectFieldChangesOptions): FieldChangeData {
  const { task, userId, userTimezone, skipProjectValidation = false } = options
  const now = options.now ?? new Date()

  // §5: what this update leaves behind — a quota, or an ordinary task.
  //
  // Asked of the RESULTING row rather than of the payload, the way the
  // reminder/track exclusivity check in `assertQuotaInvariants` is:
  // `is_tracked: false` on its own
  // retires a quota, and `is_tracked: true` on its own converts a task into
  // one, and neither request mentions the other's fields.
  const wasTracked = isTracked(task)
  const willBeTracked = isTracked({
    is_tracked: options.input.is_tracked ?? task.is_tracked,
    progress_target: options.input.progress_target ?? task.progress_target,
  })
  const willBeReminder = options.input.is_reminder ?? task.is_reminder
  assertQuotaInvariants(task, options.input, willBeTracked, willBeReminder)

  // Retiring a quota takes its rule with it.
  //
  // A quota's rule is a bare period rule ("FREQ=WEEKLY"), legal only while the
  // row is tracked (`periodRuleOnlyWhenTracked`). Left behind on the retired
  // task it would be evaluated as a schedule — and with no due_at to anchor
  // it, `effectiveDueAt` asks rrule.js for today's occurrence of a bare weekly
  // rule, which lands on an arbitrary weekday. Clearing it here rather than in
  // updateTask means bulk edit retires correctly too.
  const ctx = options.targetCtx ?? getTargetContext(task.user_id)
  // RELATIVE TARGETS (2026-10-24): a sent period sets the time first
  // (`linkTargetTime`, the owner's periods), so every planner below sees the
  // time it follows; `link` is what the write does to the link.
  const linked = linkTargetTime(task.user_id, options.input, options.slotsFor)
  const sentInput = linked.input
  // DEADLINE-ANCHORED REPEATS (2026-10-21): what this write does to the
  // schedule — the anchor, the deadline occurrence, the relative target —
  // decided up front on the RESULTING row (`planRepeatSchedule`, every 400).
  const repeat = planRepeatSchedule(task, sentInput, {
    isReminder: willBeReminder,
    isTracked: willBeTracked,
    timezone: userTimezone,
    morningTime: ctx.morningTime,
    now,
    dayStart: dayBoundaryForUser(task.user_id),
    leads: taskQueueEnabled(),
  })
  const retired = withRuleTime(
    task,
    scheduleInput(
      wasTracked && !willBeTracked && sentInput.rrule === undefined
        ? { ...sentInput, rrule: null }
        : sentInput,
      repeat,
    ),
    willBeTracked,
    { morningTime: ctx.morningTime, timezone: userTimezone },
  )
  // RELATIVE TARGETS (2026-10-24): a row the write leaves a one-off — the
  // offsets it carries (sent, kept, or kept by Stop repeating) and their 400s.
  const oneOff = oneOffRelative(task, retired, { willBeTracked, willBeReminder, ctx })
  // ON DECK (2026-10-20): a deck write is judged here, up front, and drops a
  // picked target (rule 1) — before `resolveTargetInput`, so a deadline task
  // gets its automatic target back exactly as "Back to auto" would (and a
  // relative one-off loses its offsets and link with it).
  const decking = prepareDeck(task, retired, { willBeTracked, willBeReminder, ctx, now })
  const target = resolveTargetInput(task, decking, {
    willBeTracked,
    willBeReminder,
    ctx,
    now,
    oneOff,
  })
  const input = withRepeatDates(target.input, repeat)

  const data: FieldChangeData = {
    setClauses: [],
    values: [],
    fieldsChanged: [],
    beforeState: { id: task.id, title: task.title },
    afterState: { id: task.id, title: task.title },
    isSnoozeScenario: false,
    cappedAtDeadline: target.capped || repeatCapped(repeat),
  }

  // Track basic field changes
  collectBasicFields(data, task, input, userId, skipProjectValidation, willBeReminder)
  collectTaskModelFields(data, task, input, now)
  collectQuotaPromptFields(data, task, input)

  // Track rrule changes with anchor derivation
  const rrule = collectRruleChanges(data, task, input, userTimezone, now, {
    willBeTracked,
    willBeReminder,
    deadlineAnchored: repeat.kind === 'deadline',
  })

  // Track due_at changes and move detection. Only a date the USER sent is a
  // move — not a clear, and not the automatic target the server put in its
  // place (a deadline edit, "Back to auto").
  const userMoved = decking.due_at !== undefined && decking.due_at !== null
  collectDueAtChanges(
    data,
    task,
    input,
    rrule.changed,
    userMoved && !(willBeReminder && reschedulesReminder(input)),
  )

  // §6: a repeating task's scheduled occurrence, apart from its target.
  collectOccurrence(data, task, input, rrule, willBeTracked, willBeReminder, repeat)
  collectRepeatSchedule(data, task, repeat)
  // The relative target the write leaves — one shape for both kinds of row.
  collectRelativeTarget(data, task, relativeLeft(repeat, target.relative), linked.link)
  collectTargetBack(data, task, repeat)
  // Repeat ends (2026-10-22): judged once the occurrence is decided.
  collectRepeatEnds(data, task, input, {
    isReminder: willBeReminder,
    isTracked: willBeTracked,
    timezone: userTimezone,
    now,
  })
  // §8: whether the target the write leaves is the deadline's automatic one.
  if (target.auto !== task.target_auto) {
    trackField(data, 'target_auto', task.target_auto, target.auto, undefined, target.auto ? 1 : 0)
  }
  // The deadlines page (2026-10-22): the lead override and the lead day.
  collectLead(data, task, input, {
    isReminder: willBeReminder,
    isTracked: willBeTracked,
    timezone: userTimezone,
    now,
    rolloverTime: options.rolloverTime,
  })

  // Whatever date the row still carried, drop it if it is (or is becoming) a quota
  collectQuotaDateClear(data, task, willBeTracked)
  // A row becoming a quota, or a quota whose period changes, is anchored now.
  collectQuotaAnchor(data, task, input, wasTracked, willBeTracked, now)

  // §6: a reminder is never snoozed — the same refusal `snoozeTask` makes,
  // enforced here because a bare `{ due_at }` on a dated reminder is a move
  // by every other measure and used to walk straight past it. Here rather
  // than in updateTask so the single PATCH and bulk edit refuse it alike.
  //
  // An EXPLICIT reschedule is still allowed: `reset_original_due_at: true`
  // with the date is what a period move sends for its reminders — the one
  // place the flag still means something (`reschedulesReminder`). Nor does
  // giving an undated ("anytime") reminder its first date, or a schedule
  // change that recomputes one, count as a snooze.
  //
  // Asked of the RESULTING flag, like the exclusivity guard in
  // `assertQuotaInvariants`, so
  // `{ is_reminder: true, due_at }` — convert and snooze in one request — is
  // refused too; the date has to be an explicit reschedule to travel with it.
  if (data.isSnoozeScenario && willBeReminder) {
    throw new ValidationError(
      `${REMINDER_SNOOZE_MESSAGE}. To move one to a new time, send reset_original_due_at: true with the due_at.`,
    )
  }

  // The task queue (2026-10-19): a defer's mark, before the stamp so the
  // stamp sees it and leaves it (`src/core/tasks/target-set.ts`).
  collectQueueFields(data, task, input)

  // On deck (2026-10-20): the deck this write sets or clears, and — the
  // pick-only clear (B1, `deck-clear.ts`) — a write that leaves a PICKED
  // target (or a reminder, a quota) takes an existing deck off. Judged on the
  // RESULTING row. A schedule change on a decked repeat computes no target
  // (PR 4a, `occurrenceIsPersonal`), so the deck stays — unless the deadline
  // it leaves outranks it (A1). A deadline change or Back to auto leaves an
  // automatic target, and the deck stays.
  collectDeckChange(data, task, input, {
    auto: target.auto,
    isReminder: willBeReminder,
    isTracked: willBeTracked,
    ctx,
    now,
  })
  // A repeating task leaving the deck gets its target back on its occurrence.
  collectRepeatingUndeck(data, task, input, {
    willBeReminder,
    willBeTracked,
    timezone: userTimezone,
  })

  // Upcoming (2026-10-12): any change to the target or the deadline restarts
  // the wait its heads-ups are counted over (`src/core/tasks/target-set.ts`).
  // Last, once everything above has decided `due_at` and `deadline_at`. It
  // also clears the queue mark — unless this write is the defer that set it.
  // A deck write stamps too (A6) and takes the task out of the queue (B8).
  stampTargetSet(data, task, now.toISOString(), {
    keepQueue: input.queue_mark !== undefined || input.try_tomorrow !== undefined,
    // Only a NEW deck day: re-decking for the same day keeps the heads-up anchor.
    deck: typeof input.on_deck_day === 'string' && input.on_deck_day !== task.on_deck_day,
    // A period retime moves linked targets without the user setting one
    // (decision 11): the heads-up anchor stays; attempts are checkpointed.
    keepSetAt: !!input.retime,
  })

  return data
}

/**
 * The queue mark and Try Tomorrow flag a defer sets (task queue, 2026-10-19).
 * Written only when they change, like every other tracked field; booleans in
 * the snapshot, 0/1 in the column.
 */
function collectQueueFields(data: FieldChangeData, task: Task, input: FieldChangesInput): void {
  if (input.queue_mark !== undefined && input.queue_mark !== task.queue_mark) {
    trackField(
      data,
      'queue_mark',
      task.queue_mark,
      input.queue_mark,
      undefined,
      input.queue_mark ? 1 : 0,
    )
  }
  if (
    input.queued_from_due_at !== undefined &&
    input.queued_from_due_at !== task.queued_from_due_at
  ) {
    trackField(data, 'queued_from_due_at', task.queued_from_due_at, input.queued_from_due_at)
  }
  if (input.try_tomorrow !== undefined && input.try_tomorrow !== task.try_tomorrow) {
    trackField(
      data,
      'try_tomorrow',
      task.try_tomorrow,
      input.try_tomorrow,
      undefined,
      input.try_tomorrow ? 1 : 0,
    )
  }
}

/**
 * Every non-quota rule has a time of day (2026-10-12, `fillRuleTime` in
 * `src/core/recurrence/rule-time.ts`): a NEW rule sent without BYHOUR takes
 * the time of a date sent with it, else the task's `anchor_time`, else its
 * current date's time, else the user's Morning time. Done here, before
 * anything else reads `input.rrule`, so the rule change, its anchors, the
 * occurrence it schedules and the undo snapshot all see the stored form — and
 * a timeless client re-sending a rule the row already stores with its time
 * fills to that same string and changes nothing.
 *
 * Judged on the RESULTING row: a quota (`willBeTracked`) keeps its bare
 * period rule, even when this request is what makes it one. A rule sent
 * exactly as stored is left alone — re-sending an unchanged (legacy,
 * timeless) rule is not a schedule change.
 */
function withRuleTime(
  task: Task,
  input: FieldChangesInput,
  willBeTracked: boolean,
  user: { morningTime: string; timezone: string },
): FieldChangesInput {
  if (!input.rrule || input.rrule === task.rrule) return input
  const rrule = fillRuleTime(input.rrule, willBeTracked, {
    requestDueAt: input.due_at ?? null,
    anchorTime: task.anchor_time,
    existingDueAt: task.due_at,
    ...user,
  })
  return rrule === input.rrule ? input : { ...input, rrule }
}

/**
 * §8 (2026-10-12): put the target the write leaves through `resolveTarget` —
 * the automatic target of a deadline with none, its re-derivation when the
 * deadline moves, the target ≤ deadline cap — and send the result on as an
 * ordinary `due_at`, so everything below treats it like any other date.
 * `capped`: the date the caller SENT was past the deadline and stopped at it
 * (the response's `capped_at_deadline`, ruling A3's feedback).
 */
function resolveTargetInput(
  task: Task,
  input: FieldChangesInput,
  opts: {
    willBeTracked: boolean
    willBeReminder: boolean
    ctx: TargetContext
    now: Date
    oneOff: OneOffRelative
  },
): {
  input: FieldChangesInput
  auto: boolean
  capped: boolean
  relative: RelativeTarget | null | undefined
} {
  const rrule = input.rrule !== undefined ? input.rrule : task.rrule
  const dueWritten = input.due_at !== undefined
  const left = dueWritten ? (input.due_at ?? null) : task.due_at
  const deadlineAt = input.deadline_at !== undefined ? input.deadline_at : task.deadline_at
  const resolved = resolveTarget(
    {
      dueAt: left,
      dueWritten,
      wasAuto: task.target_auto,
      deadlineAt,
      deadlineChanged: deadlineAt !== task.deadline_at,
      autoEligible: !rrule && !opts.willBeReminder && !opts.willBeTracked,
      // The deadlines page (switch on): no automatic target is written.
      leads: taskQueueEnabled(),
      // Relative targets (2026-10-24): a one-off's offsets, judged first.
      ...(opts.oneOff.relative !== undefined
        ? { relative: opts.oneOff.relative, relativeWritten: opts.oneOff.written }
        : {}),
    },
    opts.ctx,
    opts.now,
  )
  const out = resolved.dueAt === left ? input : { ...input, due_at: resolved.dueAt }
  return {
    input: out,
    auto: resolved.auto,
    capped: resolved.capped && dueWritten,
    relative: resolved.relative,
  }
}

/** A row the write leaves a one-off: its offsets, and whether the write sent them. */
interface OneOffRelative {
  /** The offsets (possibly null); undefined when the row is not an ordinary one-off. */
  relative: RelativeTarget | null | undefined
  written: boolean
}

/**
 * RELATIVE TARGETS (2026-10-24; docs/TASK-MODEL.md § Relative targets): when
 * the row this write leaves is an ordinary ONE-OFF, the offsets it carries
 * into `resolveTarget` — the ones sent (merged over the stored, every 400 in
 * `assertOneOffRelative`), else the stored ones: a one-off's own, or a
 * deadline-anchored repeat's when Stop repeating keeps them (ruling 6,
 * `stopKeepsRelative`). `resolveTarget` then keeps, derives or clears them.
 * Judged in the OWNER's zone.
 */
function oneOffRelative(
  task: Task,
  input: FieldChangesInput,
  opts: { willBeTracked: boolean; willBeReminder: boolean; ctx: TargetContext },
): OneOffRelative {
  const rule = input.rrule !== undefined ? input.rrule : task.rrule
  if (rule) return { relative: undefined, written: false }
  const ordinary = !opts.willBeReminder && !opts.willBeTracked
  const keeps =
    !!task.rrule && stopKeepsRelative(task, input, { ordinary, timezone: opts.ctx.timezone })
  const stored =
    !task.rrule || keeps
      ? { target_days_before: task.target_days_before, target_time: task.target_time }
      : { target_days_before: null, target_time: null }
  const sent = assertOneOffRelative(input, {
    stored,
    ordinary,
    deadlineAt: input.deadline_at !== undefined ? input.deadline_at : task.deadline_at,
    timezone: opts.ctx.timezone,
  })
  if (sent !== undefined) return { relative: sent, written: true }
  if (!ordinary) return { relative: undefined, written: false }
  return { relative: relativeOf(stored), written: false }
}

/**
 * ON DECK (2026-10-20, docs/TASK-MODEL.md § On deck): a write that puts the
 * task on deck (`on_deck_day` a date) is checked and prepared here.
 *
 * Refused (the whole write — the deck endpoint filters first and counts
 * instead, `src/core/tasks/deck.ts`):
 *  - with the task queue off (409: decks need the rollover that clears them);
 *  - with a target or a rule in the same write (never both);
 *  - a task that can't be on deck: done, a reminder, a quota (rule 6) —
 *    asked of the RESULTING row;
 *  - a day that is not a date, or before the calendar today;
 *  - a deadline task whose automatic target has arrived, or a day after it
 *    (A1, `deckRefusal`).
 *
 * Rule 1, "never both": a PICKED target is dropped (`due_at: null`), which
 * `resolveTargetInput` turns into the deadline's automatic target when the
 * task has one. The time goes with it. A REPEATING task's target is always
 * a pick (it has no automatic one), so decking one sets `due_at` NULL and
 * keeps `occurrence_at` (`collectOccurrence` copies the old target into it on
 * a row from before the column): the deck is for its CURRENT occurrence.
 * Taking a one-off OFF deck (null) needs no check and changes nothing else; a
 * repeating one gets its target back (`collectRepeatingUndeck`).
 */
function prepareDeck(
  task: Task,
  input: FieldChangesInput,
  opts: { willBeTracked: boolean; willBeReminder: boolean; ctx: TargetContext; now: Date },
): FieldChangesInput {
  const day = input.on_deck_day
  if (typeof day !== 'string') return input
  if (!taskQueueEnabled()) {
    throw new AppError('On deck needs the task queue, which is off on this server', 409, 'CONFLICT')
  }
  // Never both (rule 1), on EVERY path: a deck write carrying its own target
  // (a PATCH, a bulk edit's `changes.due_at` or `delta_minutes`) is refused,
  // not resolved — the schemas refuse it too; this is the core's guarantee.
  // A deadline in the same write is fine (D2 review): A1 below judges the
  // deck against the deadline the write LEAVES.
  if (input.due_at !== undefined) {
    throw new ValidationError(DECK_WITH_DATE_MESSAGE)
  }
  // Nor a rule (2026-10-20): a new schedule sets its own date (a pick), which
  // would take the deck straight off — and on a one-off it makes the task
  // repeating with the deck judged against a rule it never had.
  if (input.rrule !== undefined) {
    throw new ValidationError(DECK_WITH_RULE_MESSAGE)
  }
  const skip = deckSkip({
    is_reminder: opts.willBeReminder,
    is_tracked: opts.willBeTracked,
    done: task.done,
    deleted_at: task.deleted_at,
  })
  if (skip) {
    throw new ValidationError(
      `Only an open task that is not a reminder or quota can go on deck (this is ${skip})`,
    )
  }
  // Today is the owner's OpenTask day (a deck day is theirs).
  const problem = deckDayProblem(day, opts.ctx.timezone, opts.now, dayBoundaryForUser(task.user_id))
  if (problem) throw new ValidationError(problem)
  // A1 (2026-10-22) against the RESULTING deadline: the deck day at most its
  // OpenTask day, while it is ahead.
  const judged = {
    deadline_at: input.deadline_at !== undefined ? input.deadline_at : task.deadline_at,
  }
  const refusal = deckRefusal(judged, day, opts.ctx, opts.now, deckRolloverTime(task))
  if (refusal) {
    throw new ValidationError(
      task.rrule && refusal === 'after_auto_target'
        ? REPEATING_DECK_REFUSAL_MESSAGE
        : DECK_REFUSAL_MESSAGES[refusal],
    )
  }
  const out: FieldChangesInput = hasPickedTarget(task) ? { ...input, due_at: null } : { ...input }
  // A7 on every deck write (D2 review): a new deck day marks the task
  // considered and stamps the Just now card, as the deck endpoint does (it
  // passes its own stamps, kept here). Re-decking for the same day stamps
  // nothing new. NOT the consider on a row the deadlines page keeps
  // (2026-10-22, Trent: it stays there, waiting, with its deck day).
  if (task.on_deck_day !== day) {
    const stamp = opts.now.toISOString()
    if (
      !taskQueueEnabled() ||
      !deckKeepsPageRow(task, day, judged.deadline_at, opts.ctx.timezone, opts.now)
    ) {
      out.last_considered_at ??= stamp
    }
    out.segment_targeted_at ??= stamp
  }
  return out
}

/**
 * The deck this write sets or clears itself (`on_deck_day` in the input), or
 * else the pick-only clear on the RESULTING row (`deck-clear.ts`).
 */
function collectDeckChange(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  left: { auto: boolean; isReminder: boolean; isTracked: boolean; ctx: TargetContext; now: Date },
): void {
  if (input.on_deck_day !== undefined) {
    if (input.on_deck_day !== task.on_deck_day) {
      trackField(data, 'on_deck_day', task.on_deck_day, input.on_deck_day)
      // Taking it OFF deck stamps nothing, and takes back the deck's Just
      // now stamp — the card would otherwise call the task "Targeted".
      if (input.on_deck_day === null && task.segment_targeted_at && !hasPickedTarget(task)) {
        trackField(data, 'segment_targeted_at', task.segment_targeted_at, null)
      }
    }
    return
  }
  const { ctx, now, ...kind } = left
  collectDeckClear(data, task, {
    dueAt: data.afterState.due_at !== undefined ? data.afterState.due_at : task.due_at,
    rrule: input.rrule !== undefined ? input.rrule : task.rrule,
    ...kind,
    deadline: {
      at: input.deadline_at !== undefined ? input.deadline_at : task.deadline_at,
      changed: data.fieldsChanged.includes('deadline_at'),
      ctx,
      now,
      rolloverTime: task.on_deck_day ? deckRolloverTime(task) : null,
    },
  })
}

/**
 * ON DECK, REPEATING (2026-10-20): a repeating task is never left without a
 * target off deck. Whatever takes it off — the deck write's `null`, the A1
 * clear when a deadline outranks the deck — puts `due_at` back on its
 * scheduled occurrence's own target (`occurrenceDates`: a deadline-anchored
 * repeat's lies before its deadline), and `original_due_at` with it (old native builds read it). The debt returns: the occurrence may
 * already be over target and nag at once — intended. A write that sets
 * `due_at` itself (a pick, a new rule) or makes the task a reminder or a
 * quota leaves it to that write.
 */
function collectRepeatingUndeck(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  left: { willBeReminder: boolean; willBeTracked: boolean; timezone: string },
): void {
  if (!task.on_deck_day || data.afterState.on_deck_day !== null) return
  const rule = input.rrule !== undefined ? input.rrule : task.rrule
  if (!rule || left.willBeReminder || left.willBeTracked) return
  if (data.fieldsChanged.includes('due_at') || task.due_at !== null) return
  const after = <K extends keyof Task>(field: K): Task[K] =>
    data.afterState[field] !== undefined ? (data.afterState[field] as Task[K]) : task[field]
  const occurrence = after('occurrence_at')
  if (!occurrence) return
  // The schedule this write LEAVES: a schedule change that keeps the deck
  // until A1 takes it off (PR 4a) may have changed the rule or the offsets.
  const schedule = {
    rrule: rule,
    repeat_anchor: after('repeat_anchor'),
    target_days_before: after('target_days_before'),
    target_time: after('target_time'),
  }
  const restored = occurrenceDates(schedule, occurrence, left.timezone).targetAt
  // No relative target (L1): the occurrence has none to come back — it stays
  // target-less, on the deadlines page from its lead day.
  if (restored === null) return
  trackField(data, 'due_at', task.due_at, restored)
  if (task.original_due_at !== restored && !data.fieldsChanged.includes('original_due_at')) {
    trackField(data, 'original_due_at', task.original_due_at, restored)
  }
}

/** The fields whose change re-derives the lead day (`collectLead`). */
const LEAD_INPUTS = [
  'deadline_at',
  'rrule',
  'repeat_anchor',
  'target_days_before',
  'target_time',
  'occurrence_at',
  'is_reminder',
  'is_tracked',
  'progress_target',
  'lead_days',
]

/**
 * THE DEADLINES PAGE (2026-10-22; docs/TASK-MODEL.md § The deadlines page):
 * `lead_days` as sent (the override; a reminder or a quota keeps none), and
 * `lead_from` — this instance's lead day — RE-DERIVED (`leadFor`, from now)
 * whenever the write changes the deadline, the schedule, the row's kind or
 * the override: a deferral is dropped, as a deadline change used to re-derive
 * the automatic target. Also filled when the row it leaves is a target-less
 * deadline task that has none (a row from before the column).
 *
 * A5 (switch on): a deadline-anchored repeat WITH a relative target whose
 * target this write REMOVES (`target_at: null`) goes on the page today; the
 * next advance gives the next occurrence its derived target again.
 *
 * Written whatever the task-queue switch says (dormant while the task has a
 * target); only the page itself, and the automatic target's absence, ride
 * the switch.
 */
function collectLead(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  left: {
    isReminder: boolean
    isTracked: boolean
    timezone: string
    now: Date
    rolloverTime?: string
  },
): void {
  const after = <K extends keyof Task>(field: K): Task[K] =>
    data.afterState[field] !== undefined ? (data.afterState[field] as Task[K]) : task[field]
  const ordinary = !left.isReminder && !left.isTracked
  if (input.lead_days !== undefined) {
    const leadDays = ordinary ? input.lead_days : null
    if (leadDays !== task.lead_days) trackField(data, 'lead_days', task.lead_days, leadDays)
  } else if (!ordinary && task.lead_days !== null) {
    trackField(data, 'lead_days', task.lead_days, null)
  }
  const row = {
    rrule: after('rrule'),
    repeat_anchor: after('repeat_anchor'),
    target_days_before: after('target_days_before'),
    target_time: after('target_time'),
    recurrence_mode: after('recurrence_mode'),
    anchor_time: after('anchor_time'),
    lead_days: after('lead_days'),
    deadline_at: after('deadline_at'),
    occurrence_at: after('occurrence_at'),
    is_reminder: left.isReminder,
    is_tracked: left.isTracked,
  }
  const changed = LEAD_INPUTS.some((f) => data.fieldsChanged.includes(f))
  const targetLess = row.deadline_at !== null && after('due_at') === null
  const removedRepeatTarget = ordinary && targetLess && removesRepeatTarget(data, task, input, row)
  if (!changed && !removedRepeatTarget && !(targetLess && task.lead_from === null)) return
  if (changed) assertLeadDays(row, after('due_at'), left.timezone)
  const rolloverTime = left.rolloverTime ?? rolloverTimeForUser(task.user_id)
  const lead = { rolloverTime, now: left.now }
  const next = removedRepeatTarget
    ? openTaskToday(left.timezone, left.now, rolloverTime)
    : leadFor(row, left.timezone, lead)
  if (next !== task.lead_from) trackField(data, 'lead_from', task.lead_from, next)
}

/**
 * A repeat's lead override must be shorter than its rule's wait (a 400, like
 * `overlaps_previous` — `leadDaysProblem`). Judged on the row the write leaves.
 * EVERY repeat since the Upcoming split (2026-10-25): the lead is also the
 * Later day ahead of each occurrence's target, so a weekly rule with a lead
 * of 10 would put every occurrence in Upcoming the moment the last was done.
 * The walk starts at the occurrence (a deadline-anchored rule's is its
 * deadline; a target-anchored one's its target).
 */
function assertLeadDays(row: LeadFields, dueAt: string | null, timezone: string): void {
  if (!row.rrule || row.lead_days == null) return
  const first = row.occurrence_at ?? (isDeadlineAnchored(row) ? row.deadline_at : dueAt)
  if (!first) return
  const problem = leadDaysProblem(
    row.lead_days,
    {
      rrule: row.rrule,
      recurrence_mode: row.recurrence_mode ?? 'from_due',
      anchor_time: row.anchor_time ?? null,
    },
    first,
    timezone,
  )
  if (problem) throw new ValidationError(problem)
}

/**
 * A5 (`collectLead`): this write REMOVES the target of a deadline-anchored
 * repeat WITH a relative target — not by a deck (the deck the write leaves,
 * read from the input: the after-state does not have it yet).
 */
function removesRepeatTarget(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  row: Parameters<typeof isDeadlineAnchored>[0] & Parameters<typeof hasRelativeTarget>[0],
): boolean {
  const deck = input.on_deck_day !== undefined ? input.on_deck_day : task.on_deck_day
  return (
    task.due_at !== null &&
    data.fieldsChanged.includes('due_at') &&
    !deck &&
    isDeadlineAnchored(row) &&
    hasRelativeTarget(row)
  )
}

/**
 * The input a repeat plan sends on (2026-10-21), BEFORE the rule's time is
 * filled: a deadline-anchored rule timed by its deadline (not by a target
 * sent with it), and — a deadline-anchored repeat switching to its target —
 * the deadline cleared in the same write (L7).
 */
function scheduleInput(input: FieldChangesInput, repeat: RepeatPlan): FieldChangesInput {
  if (repeat.kind === 'target' && repeat.clearDeadline) return { ...input, deadline_at: null }
  if (repeat.kind === 'deadline' && repeat.rrule !== undefined) {
    return { ...input, rrule: repeat.rrule }
  }
  return input
}

/**
 * A deadline-anchored repeat's dates (2026-10-21), sent on as ordinary
 * `deadline_at` and `due_at` once the target has been resolved: the deadline
 * is the occurrence `planRepeatSchedule` decided, the target its derived one
 * (or the move, or the kept moved target, capped). Only what the plan set.
 */
function withRepeatDates(input: FieldChangesInput, repeat: RepeatPlan): FieldChangesInput {
  if (repeat.kind !== 'deadline') return input
  const out: FieldChangesInput = { ...input, deadline_at: repeat.occurrenceAt }
  if (repeat.dueAt !== undefined) out.due_at = repeat.dueAt
  return out
}

/** A deadline-anchored repeat's move that stopped at its (new) deadline. */
function repeatCapped(repeat: RepeatPlan): boolean {
  return repeat.kind === 'deadline' && repeat.capped
}

/**
 * The anchor (2026-10-21): written as the plan leaves it — 'deadline', or
 * back to 'target'. The offsets are `collectRelativeTarget`'s (2026-10-24):
 * a repeat leaving its anchor may become a relative one-off (ruling 6).
 */
function collectRepeatSchedule(data: FieldChangeData, task: Task, repeat: RepeatPlan): void {
  if (repeat.kind === 'none') return
  const anchor = repeat.kind === 'deadline' ? ('deadline' as const) : ('target' as const)
  if (anchor !== task.repeat_anchor) {
    trackField(data, 'repeat_anchor', task.repeat_anchor, anchor)
  }
}

/** The offsets the write leaves: a deadline-anchored repeat's plan, else the one-off's. */
function relativeLeft(
  repeat: RepeatPlan,
  oneOff: RelativeTarget | null | undefined,
): RelativeTarget | null {
  if (repeat.kind === 'deadline') return repeat.relative
  return oneOff ?? null
}

/**
 * THE RELATIVE TARGET A WRITE LEAVES (2026-10-24; one shape for a
 * deadline-anchored repeat and a one-off): `target_days_before`,
 * `target_time` and `target_slot_id` — the planner's offsets for a repeat,
 * `resolveTarget`'s for a one-off, none for anything else (a target-anchored
 * repeat, a reminder, a quota) — and the link (`linkAfter`: none without
 * offsets, kept only at the linked time). When any of the three changes, all
 * three go in the snapshot, beside `due_at`, so undo puts the whole relative
 * target back together.
 */
function collectRelativeTarget(
  data: FieldChangeData,
  task: Task,
  relative: RelativeTarget | null,
  link: number | null | undefined,
): void {
  const after = {
    target_days_before: relative?.days_before ?? null,
    target_time: relative?.time ?? null,
    target_slot_id: linkAfter(task, relative, link),
  }
  const fields = ['target_days_before', 'target_time', 'target_slot_id'] as const
  if (fields.every((f) => after[f] === task[f])) return
  for (const f of fields) trackField(data, f, task[f], after[f])
}

/**
 * A repeat LEAVING its deadline anchor with no target (the deadlines page,
 * 2026-10-22: a deadline-anchored repeat with no relative target has none)
 * gets one back: a target-anchored occurrence IS its target, so `due_at` :=
 * the occurrence it is left on — unless it is on deck, or the write set a
 * date itself. Never a stuck target-less target-anchored repeat (TM-INV-08).
 */
function collectTargetBack(data: FieldChangeData, task: Task, repeat: RepeatPlan): void {
  if (repeat.kind !== 'target' || data.fieldsChanged.includes('due_at')) return
  const after = <K extends keyof Task>(field: K): Task[K] =>
    data.afterState[field] !== undefined ? (data.afterState[field] as Task[K]) : task[field]
  if (after('due_at') !== null || after('on_deck_day') || !after('rrule')) return
  const occurrence = after('occurrence_at')
  if (!occurrence) return
  trackField(data, 'due_at', task.due_at, occurrence)
}

/** A period move's explicit reschedule of a reminder — not a snooze (see the guard above). */
function reschedulesReminder(input: FieldChangesInput): boolean {
  return input.reset_original_due_at === true
}

/**
 * §6 (2026-10-12): a repeating task's SCHEDULED occurrence (`occurrence_at`),
 * kept apart from its target (`due_at`). A move changes only the target; done
 * and skip advance from the occurrence (`computeMarkDone`, `skip.ts`). Here:
 * - a schedule change (a new rule) sets it to the occurrence the rule gives —
 *   or to the date sent with the rule;
 * - a reminder's date IS its occurrence (a reminder is never moved, only
 *   rescheduled), so it follows `due_at`;
 * - a row from before the column, or an undated repeating task getting its
 *   first date, takes the target it had (or the new one);
 * - a one-off (or a quota) has none;
 * - a DEADLINE-ANCHORED repeat's is its deadline, as `planRepeatSchedule`
 *   decided it (2026-10-21) — never a target.
 */
function collectOccurrence(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  rrule: RruleChange,
  willBeTracked: boolean,
  willBeReminder: boolean,
  repeat: RepeatPlan,
): void {
  const resultingRule = input.rrule !== undefined ? input.rrule : task.rrule
  const dueAfter = data.afterState.due_at !== undefined ? data.afterState.due_at : task.due_at
  let next: string | null
  if (!resultingRule || willBeTracked) next = null
  // A deadline-anchored repeat's occurrence IS its deadline (2026-10-21).
  else if (repeat.kind === 'deadline') next = repeat.occurrenceAt
  else if (rrule.changed) next = rrule.scheduled ?? dueAfter ?? null
  else if (willBeReminder) next = dueAfter ?? null
  else if (task.occurrence_at === null && data.fieldsChanged.includes('due_at')) {
    next = task.due_at ?? dueAfter ?? null
  } else return
  if (next !== task.occurrence_at) trackField(data, 'occurrence_at', task.occurrence_at, next)
}

/**
 * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends): the end this
 * write leaves, judged on the RESULTING row (`repeatEndProblem`, every 400):
 *  - `rrule: null` (stop repeating) clears all three columns;
 *  - a count set where there was none starts the count: `used` = 0, the
 *    current occurrence is #1 (A3); changing N keeps `used` (N > used, A7);
 *  - setting one end clears the other; null clears it;
 *  - a rule change keeps the end and `used` (a rule sent without an end —
 *    validation lifted any COUNT/UNTIL — leaves the stored end alone).
 */
function collectRepeatEnds(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  left: { isReminder: boolean; isTracked: boolean; timezone: string; now: Date },
): void {
  const rule = input.rrule !== undefined ? input.rrule : task.rrule
  if (!rule && (input.repeat_count != null || input.repeat_until != null)) {
    throw new ValidationError(REPEAT_END_MESSAGES.ends_need_rule)
  }
  const { count, until, used } = rule
    ? resultingEnd(task, input)
    : { count: null, until: null, used: 0 }
  if (rule) {
    const occurrenceAt =
      data.afterState.occurrence_at !== undefined
        ? data.afterState.occurrence_at
        : task.occurrence_at
    const problem = repeatEndProblem(
      {
        count,
        until,
        used,
        // Written = CHANGED: a client echoing the stored end back (the editor
        // saves the whole draft) is not re-judged — a date already passed
        // while its last occurrence is debt must not 400 a title edit.
        countWritten: input.repeat_count !== undefined && input.repeat_count !== task.repeat_count,
        untilWritten: input.repeat_until !== undefined && input.repeat_until !== task.repeat_until,
        walkWritten: ['rrule', 'recurrence_mode', 'repeat_anchor'].some((f) =>
          data.fieldsChanged.includes(f),
        ),
        occurrenceAt: occurrenceAt ?? null,
        hasRule: true,
        isReminder: left.isReminder,
        isTracked: left.isTracked,
      },
      left.timezone,
      left.now,
      dayBoundaryForUser(task.user_id),
    )
    if (problem) throw new ValidationError(REPEAT_END_MESSAGES[problem])
  }
  if (count !== task.repeat_count) trackField(data, 'repeat_count', task.repeat_count, count)
  if (until !== task.repeat_until) trackField(data, 'repeat_until', task.repeat_until, until)
  if (used !== task.repeat_count_used) {
    trackField(data, 'repeat_count_used', task.repeat_count_used, used)
  }
}

/** The end a write leaves on a repeating task (`collectRepeatEnds`'s rules). */
function resultingEnd(
  task: Task,
  input: FieldChangesInput,
): { count: number | null; until: string | null; used: number } {
  const countWritten = input.repeat_count !== undefined
  const untilWritten = input.repeat_until !== undefined
  let count = task.repeat_count
  let until = task.repeat_until
  let used = task.repeat_count_used
  if (countWritten) {
    if (input.repeat_count !== null && task.repeat_count === null) used = 0
    count = input.repeat_count ?? null
    if (count !== null && !untilWritten) until = null
  }
  if (untilWritten) {
    until = input.repeat_until ?? null
    if (until !== null && !countWritten) count = null
  }
  return { count, until, used }
}

/**
 * The quota invariants an edit is refused on up front, all asked of the
 * RESULTING row (`willBeTracked`, `willBeReminder`) rather than the payload.
 * Each throws ValidationError, which in a bulk edit aborts the WHOLE batch (a
 * 400, not a skip). The reminder-snooze refusal needs the collected changes,
 * so it runs at the end of `collectFieldChanges` instead.
 */
function assertQuotaInvariants(
  task: Task,
  input: FieldChangesInput,
  willBeTracked: boolean,
  willBeReminder: boolean,
): void {
  // §5/§6 mutual exclusivity, checked against the RESULTING row rather than the
  // payload. The schema-level refusal only sees fields sent together, so it
  // cannot catch "flag this already-tracked task as a reminder" — the single
  // most likely way to reach the incoherent state from the task editor, where
  // the toggle sends `is_reminder` alone.
  //
  // `isTracked`, not `progress_target > 1`: a quota with target 1 is marked by
  // the `is_tracked` flag alone ("date night, once a month"), and testing only
  // the target let the editor toggle flip exactly those quotas into reminders.
  //
  // Here rather than in updateTask so bulk edit is held to it too: a bulk
  // `is_reminder: true` over a selection holding a quota refuses the whole
  // batch, like the other guards here.
  if (willBeReminder && willBeTracked) {
    throw new ValidationError(TRACKED_REMINDER_MESSAGE)
  }

  // A quota has no due date, so it cannot be given one — by a snooze, by the
  // task editor, or by a bulk edit that swept it up.
  if (willBeTracked && input.due_at) {
    throw new ValidationError(QUOTA_DUE_DATE_MESSAGE)
  }

  // A quota always has a period (QUOTA_PERIOD_MESSAGE) — asked of the
  // resulting row, so it refuses making a period-less task a quota, clearing a
  // quota's rule, and a bulk edit that would do either. A row that is ALREADY
  // a period-less quota (none exist in production; older data could hold one)
  // stays editable as long as the write leaves its rule alone — the display
  // paths still handle it.
  const resultingRrule = input.rrule !== undefined ? input.rrule : (task.rrule ?? null)
  const legacyPeriodless =
    isTracked(task) && quotaPeriodOf(task.rrule) === null && input.rrule === undefined
  if (willBeTracked && quotaPeriodOf(resultingRrule) === null && !legacyPeriodless) {
    throw new ValidationError(QUOTA_PERIOD_MESSAGE)
  }
  // And its period spans no more than the editor offers (QUOTA_INTERVAL_MESSAGE)
  // — judged only on a rule this write sends, so a stored rule outside the
  // range stays editable.
  if (willBeTracked && input.rrule !== undefined && !quotaIntervalAllowed(input.rrule)) {
    throw new ValidationError(QUOTA_INTERVAL_MESSAGE)
  }
}

/**
 * INTERVAL QUOTAS (2026-10-16): a quota's period is re-anchored when the row
 * BECOMES a quota, or when its period — FREQ or INTERVAL — changes.
 *
 * Without it a period edit kept the old anchor: a weekly quota changed to
 * monthly kept its Sunday, and its months ran the 11th to the 11th for good
 * (only weeks have alignment logic). Re-anchored, it starts at the current
 * unit's start (`quotaAnchorNow`: this week's first day, the 1st, midnight,
 * Jan 1) — the rule a new quota is anchored by — inside this write, so the
 * edit and the anchor are ONE undo entry, and undo puts the old rule and the
 * old anchor back together.
 *
 * THE COUNT: what was logged since the new start, never more than the count
 * already there (`min(progress_current, loggedSince(newStart))`). Weekly →
 * monthly keeps this week's taps (earlier weeks were already closed and
 * recorded by the rollover; counting them again would double them); monthly
 * → weekly keeps only this week's. This is the doc's SIMPLER alternative: the
 * part of the old window before the new start is not recorded as a short
 * period — its taps stay in `progress_events`, but no `progress_periods` row
 * or completion is written for it. Recording it would put rows in tables undo
 * cannot take back. An expired window is closed by the rollover BEFORE this
 * runs (`settleQuotaPeriod`), so a finished period is always recorded first.
 *
 * A count the request sets itself (`progress_current`) is left to the request.
 */
function collectQuotaAnchor(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  wasTracked: boolean,
  willBeTracked: boolean,
  now: Date,
): void {
  if (!willBeTracked) return
  const nextRule = input.rrule !== undefined ? input.rrule : task.rrule
  const after = quotaPeriodOf(nextRule)
  if (!after) return
  const before = quotaPeriodOf(task.rrule)
  const periodChanged =
    before === null || before.freq !== after.freq || before.interval !== after.interval
  if (wasTracked && !periodChanged) return

  const anchor = quotaAnchorNow(task.user_id, nextRule, now)
  if (!anchor) return
  if (anchor !== task.progress_period_start) {
    trackField(data, 'progress_period_start', task.progress_period_start, anchor)
  }
  if (input.progress_current !== undefined) return
  const since = DateTime.fromISO(anchor, { zone: 'utc' })
  const carried = Math.min(task.progress_current, loggedSince(task.id, since))
  if (carried !== task.progress_current) {
    trackField(data, 'progress_current', task.progress_current, carried)
  }
}

/**
 * Close a quota's expired period before an edit re-anchors it.
 *
 * The rollover runs every five minutes; a period edit in that gap would carry
 * a count belonging to a period that is already over, and that period would
 * never be recorded. So an edit that sends a rule to a quota runs the
 * rollover for it first (`rolloverQuotaNow`, the +1's own guard) and edits
 * the fresh row. A no-op when the period has not ended. Returns the task to
 * collect changes against.
 */
export function settleQuotaPeriod(task: Task, input: FieldChangesInput): Task {
  if (!isTracked(task) || input.rrule === undefined) return task
  return rolloverQuotaNow(task.id) > 0 ? (getTaskById(task.id) ?? task) : task
}

/**
 * §5: a quota carries no date, whether it was just converted into one or has
 * been one all along.
 *
 * Runs last, and only when nothing above already decided `due_at`, so an
 * explicit `due_at: null` in the payload is not written twice. Because it
 * looks at the row rather than the payload it is also self-healing: a legacy
 * quota that still holds a date from before the migration loses it the first
 * time anything about it is edited.
 *
 * `original_due_at` goes with it — it is the first-target date of a due date
 * that no longer exists.
 */
function collectQuotaDateClear(data: FieldChangeData, task: Task, willBeTracked: boolean): void {
  if (!willBeTracked) return
  if (data.afterState.due_at !== undefined) return

  if (task.due_at !== null) {
    trackField(data, 'due_at', task.due_at, null)
  }
  if (task.original_due_at !== null && !data.fieldsChanged.includes('original_due_at')) {
    data.setClauses.push('original_due_at = NULL')
    data.fieldsChanged.push('original_due_at')
    data.beforeState.original_due_at = task.original_due_at
    data.afterState.original_due_at = null
  }
}

/**
 * A reminder's explicit reschedule makes the new date its first-target date —
 * see the comment at its call in collectBasicFields.
 */
function collectOriginReset(data: FieldChangeData, task: Task, input: FieldChangesInput): void {
  const resetTo = input.due_at !== undefined ? input.due_at : task.due_at
  if (!resetTo) return
  if (task.original_due_at !== resetTo) {
    trackField(data, 'original_due_at', task.original_due_at, resetTo)
  }
}

/**
 * Task model fields (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * `deadline_at` is an ordinary field — no snooze path ever sends it, which is
 * what keeps a snooze from moving a deadline. (What a deadline change does to
 * the target — the automatic one follows it, a picked one is pulled back — is
 * `resolveTargetInput`'s.) Changing `horizon` restarts its clock
 * (`horizon_set_at`), which Process reads to ask whether it should grow;
 * re-sending the same horizon is not a change and leaves the clock alone.
 */
function collectTaskModelFields(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  now: Date,
): void {
  if (input.deadline_at !== undefined && input.deadline_at !== task.deadline_at) {
    trackField(data, 'deadline_at', task.deadline_at, input.deadline_at)
  }
  if (input.last_considered_at !== undefined) {
    trackField(data, 'last_considered_at', task.last_considered_at, input.last_considered_at)
  }
  if (input.segment_targeted_at !== undefined) {
    trackField(data, 'segment_targeted_at', task.segment_targeted_at, input.segment_targeted_at)
  }
  if (input.horizon !== undefined && input.horizon !== task.horizon) {
    trackField(data, 'horizon', task.horizon, input.horizon)
    trackField(
      data,
      'horizon_set_at',
      task.horizon_set_at,
      input.horizon ? now.toISOString() : null,
    )
  } else if (input.affirm_horizon) {
    // Process "keep" (ruling Q7, 2026-10-12): the horizon stays as it is
    // (unset stays unset) and `growth_kept_at` is stamped, so Process asks
    // again only one threshold period after it (`growthAsk`). The horizon's
    // own clock is untouched. Undo restores the old stamp like any other field.
    trackField(data, 'growth_kept_at', task.growth_kept_at, now.toISOString())
  }
}

/**
 * Collect basic field changes (title, priority, project_id, labels, recurrence_mode, notes)
 */
function collectBasicFields(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  userId: number,
  skipProjectValidation: boolean,
  willBeReminder: boolean,
): void {
  // Reset origin — A REMINDER ONLY since 2026-10-12. On a task there is no
  // snooze/re-target split any more (§6, ruling Q4): `retarget` /
  // `reset_original_due_at` are accepted from old clients and a move is a
  // move, keeping the first-target date. A reminder is never snoozed, so for
  // one the flag is still the explicit reschedule a period move sends
  // (`time-slots/edit.ts`): the new date becomes its first-target date. A
  // null date (clearing it) is not a reschedule — the due-date clear in
  // `collectDueAtChanges` takes the origin with it.
  if (input.reset_original_due_at && willBeReminder) collectOriginReset(data, task, input)

  if (input.title !== undefined && input.title !== task.title) {
    trackField(data, 'title', task.title, input.title)
  }

  // §5: the quota widget chip's short label. Ordinary field-change handling —
  // validated (trimmed, 24-char cap, '' -> null) in the Zod schema, not here.
  if (input.short_title !== undefined && input.short_title !== task.short_title) {
    trackField(data, 'short_title', task.short_title, input.short_title)
  }

  if (input.priority !== undefined && input.priority !== task.priority) {
    trackField(data, 'priority', task.priority, input.priority)
  }

  if (input.project_id !== undefined && input.project_id !== task.project_id) {
    // Validate project access unless already validated (bulk operations)
    if (!skipProjectValidation) {
      const db = getDb()
      const project = db
        .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
        .get(input.project_id) as { id: number; owner_id: number; shared: number } | undefined
      if (!project) throw new NotFoundError('Project not found')
      if (project.owner_id !== userId && project.shared !== 1) {
        throw new ForbiddenError('Access denied to project')
      }
    }
    trackField(data, 'project_id', task.project_id, input.project_id)
  }

  if (input.labels !== undefined) {
    const currentLabels = JSON.stringify(task.labels)
    const newLabels = JSON.stringify(input.labels)
    if (currentLabels !== newLabels) {
      data.setClauses.push('labels = ?')
      data.values.push(newLabels)
      data.fieldsChanged.push('labels')
      data.beforeState.labels = task.labels
      data.afterState.labels = input.labels
    }
  } else if (input.labels_add !== undefined || input.labels_remove !== undefined) {
    // Additive/subtractive label operations (used by bulk edit)
    let newLabelsArray = [...task.labels]
    if (input.labels_add) {
      for (const label of input.labels_add) {
        if (!newLabelsArray.some((l) => l.toLowerCase() === label.toLowerCase())) {
          newLabelsArray.push(label)
        }
      }
    }
    if (input.labels_remove) {
      const removeSet = new Set(input.labels_remove.map((l) => l.toLowerCase()))
      newLabelsArray = newLabelsArray.filter((l) => !removeSet.has(l.toLowerCase()))
    }
    const labelsChanged =
      newLabelsArray.length !== task.labels.length ||
      !newLabelsArray.every((l, i) => task.labels[i] === l)
    if (labelsChanged) {
      data.setClauses.push('labels = ?')
      data.values.push(JSON.stringify(newLabelsArray))
      data.fieldsChanged.push('labels')
      data.beforeState.labels = task.labels
      data.afterState.labels = newLabelsArray
    }
  }

  // Only allow recurrence_mode changes when the task has (or is getting) an rrule.
  // Setting recurrence_mode on a non-recurring task creates orphaned metadata that
  // would surprise users if the task later becomes recurring.
  if (input.recurrence_mode !== undefined && input.recurrence_mode !== task.recurrence_mode) {
    const effectiveRrule = input.rrule !== undefined ? input.rrule : task.rrule
    if (effectiveRrule !== null) {
      trackField(data, 'recurrence_mode', task.recurrence_mode, input.recurrence_mode)
    }
  }

  if (input.notes !== undefined && input.notes !== task.notes) {
    trackField(data, 'notes', task.notes, input.notes)
  }

  if (
    input.auto_snooze_minutes !== undefined &&
    input.auto_snooze_minutes !== task.auto_snooze_minutes
  ) {
    trackField(data, 'auto_snooze_minutes', task.auto_snooze_minutes, input.auto_snooze_minutes)
  }

  // §5 Track. progress_target > 1 opts in by itself; is_tracked is the explicit
  // mark for a quota whose target is 1.
  if (input.progress_target !== undefined && input.progress_target !== task.progress_target) {
    trackField(data, 'progress_target', task.progress_target, input.progress_target)
  }
  if (input.is_tracked !== undefined && input.is_tracked !== task.is_tracked) {
    trackField(
      data,
      'is_tracked',
      task.is_tracked,
      input.is_tracked,
      'is_tracked = ?',
      input.is_tracked ? 1 : 0,
    )
  }

  if (input.progress_current !== undefined && input.progress_current !== task.progress_current) {
    trackField(data, 'progress_current', task.progress_current, input.progress_current)
  }

  // §6: moving an item onto (or off) the Reminders surface. Stored as 0/1 —
  // the DB column is an integer, and writing a JS boolean would bind as such.
  if (input.is_reminder !== undefined && input.is_reminder !== task.is_reminder) {
    trackField(
      data,
      'is_reminder',
      task.is_reminder,
      input.is_reminder,
      'is_reminder = ?',
      input.is_reminder ? 1 : 0,
    )
  }
}

function collectQuotaPromptFields(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
): void {
  // Quota reminders (2026-09-24): the quota editor's "Remind me daily" switch
  // and period pickers. A JSON object — the snapshot keeps the parsed value
  // (what `rowToTask` gives every reader, and what undo re-serializes), the
  // column gets the string. Compared by content: the editor re-sends an equal
  // object on every save that touches it.
  if (
    input.quota_prompt_config !== undefined &&
    JSON.stringify(input.quota_prompt_config) !== JSON.stringify(task.quota_prompt_config)
  ) {
    // Against the quota's OWNER's periods — prompts are computed per owner —
    // so a shared-project edit cannot point a partner's quota at the editor's
    // own slots. Here rather than in updateTask so bulk edit is held to it too.
    assertPromptSlotsOwned(task.user_id, input.quota_prompt_config, task.quota_prompt_config)
    trackField(
      data,
      'quota_prompt_config',
      task.quota_prompt_config,
      input.quota_prompt_config,
      'quota_prompt_config = ?',
      input.quota_prompt_config === null ? null : JSON.stringify(input.quota_prompt_config),
    )
  }
}

/**
 * An explicit date arriving WITH a new (non-null) rule is honored, the way
 * `createTask` honors `{ rrule, due_at }`: "repeat weekly, starting on this
 * date". It used to be silently dropped at 200 — the rule branch only ever
 * auto-computed a date, `collectDueAtChanges` returns early on any rule change
 * except a clear, and the anchors were derived from the OLD date — so the
 * quick panel's "change recurrence and pick a date" lost the date. It is a
 * re-schedule, never a snooze (`rruleTakesTheOrigin` drops the origin). A
 * quota is left to the refusal / date-clear paths: it has no date to honor.
 *
 * @returns the due date the new rule's anchors should be derived from
 */
function applyDateWithNewRule(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  willBeTracked: boolean,
): string | null {
  const explicit = !willBeTracked && input.due_at !== undefined
  if (!explicit) return data.afterState.due_at ?? task.due_at
  const dueAt = input.due_at ?? null
  if (dueAt !== task.due_at) trackField(data, 'due_at', task.due_at, dueAt)
  return dueAt
}

/**
 * What `collectRruleChanges` did: whether the rule changed, and the
 * occurrence a new rule scheduled (before the deadline cap — the target may
 * be capped, the occurrence never is).
 */
interface RruleChange {
  changed: boolean
  scheduled?: string
}

/**
 * Collect rrule changes with anchor field derivation
 *
 * @returns Whether rrule changed (used by due_at logic) and what it scheduled
 */
function collectRruleChanges(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  userTimezone: string,
  now: Date,
  left: RuleChangeResult,
): RruleChange {
  const { willBeTracked } = left
  if (input.rrule === undefined || input.rrule === task.rrule) {
    return { changed: false }
  }

  trackField(data, 'rrule', task.rrule, input.rrule)

  // When an rrule change takes the occurrence origin with it — and when it
  // must not.
  //
  // The origin belongs to the schedule the task had, so a change to a NEW
  // schedule drops it. That has always been true. Clearing the rule to null was
  // added on 2026-09-08 for `{ rrule: null, due_at: X }` — "clear recurrence and
  // pick a date", which is a re-schedule and must not read as a snooze — but it
  // was applied to EVERY clear, and that was too wide: `{ rrule: null }` alone
  // on a genuinely snoozed recurring task (snooze_count 2, origin = the
  // pre-snooze date) kept the deferred `due_at` and the count while losing the
  // origin, so the row stopped drawing its snoozed stripe and the quick panel's
  // age anchor jumped back to `created_at`. A date has to be arriving in the
  // same request for the clear to mean a re-schedule.
  //
  // A reminder's explicit reschedule (`reset_original_due_at`) always wins: it
  // is the caller saying what the origin is, in the same breath.
  // `collectBasicFields` has already pushed it, and SQLite takes the last
  // clause, so without this guard the reset was silently overridden.
  //
  // PR 4a: an occurrence KEPT across the change (a deck, a moved target —
  // `keptOccurrence`) keeps its origin too: it is still the same occurrence,
  // so its age clock (the web's, and old native builds') stays honest.
  const kept = keptOccurrence(task, input, { ...left, timezone: userTimezone, now })
  const rruleTakesTheOrigin = takesTheOrigin(data, input, kept)

  if (rruleTakesTheOrigin && task.original_due_at) {
    data.setClauses.push('original_due_at = NULL')
    if (!data.fieldsChanged.includes('original_due_at')) {
      data.fieldsChanged.push('original_due_at')
      data.beforeState.original_due_at = task.original_due_at
    }
    data.afterState.original_due_at = null
  }

  if (input.rrule === null) {
    // Clearing recurrence - null out anchor fields and reset recurrence_mode
    data.setClauses.push('anchor_time = NULL, anchor_dow = NULL, anchor_dom = NULL')
    data.fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')
    data.beforeState.anchor_time = task.anchor_time
    data.beforeState.anchor_dow = task.anchor_dow
    data.beforeState.anchor_dom = task.anchor_dom
    data.afterState.anchor_time = null
    data.afterState.anchor_dow = null
    data.afterState.anchor_dom = null

    // Reset recurrence_mode to default when clearing rrule
    if (task.recurrence_mode !== 'from_due') {
      trackField(data, 'recurrence_mode', task.recurrence_mode, 'from_due')
    }
  } else {
    // Setting/changing recurrence - derive anchor fields (from the explicit
    // date, when one arrives with the rule — see applyDateWithNewRule)
    const dueAtForAnchors = applyDateWithNewRule(data, task, input, willBeTracked)
    const anchors = deriveAnchorFields(input.rrule, dueAtForAnchors, userTimezone)

    // Update anchor_time, anchor_dow and anchor_dom
    for (const field of ['anchor_time', 'anchor_dow', 'anchor_dom'] as const) {
      writeAnchor(data, task, field, anchors[field])
    }

    // Only auto-compute due_at if:
    // 1. User didn't explicitly pass due_at
    // 2. Task is NOT overdue (due_at is in the future or null) — an overdue
    //    task keeps its overdue date so a schedule edit cannot quietly clear
    //    debt the user still has to sweep.
    // 3. The occurrence is not the user's own (PR 4a, `keepPersonalOccurrence`
    //    below: a deck or a moved target is kept).
    // A reminder (§6) has no debt to protect, and a missed one's due_at is
    // just frozen at its last occurrence, so its due_at follows the new
    // schedule: the reminder editor's "move it to the evening" must not leave
    // a due date claiming last Tuesday's morning.
    //
    // A quota (§5) is skipped entirely: it has no due date to compute, and its
    // rule is a bare period rule that rrule.js would place on an arbitrary
    // weekday. This is what the quota editor's "one field this editor promises
    // not to touch" note used to be working around — it sent the rule and the
    // server stamped a date behind it.
    const isOverdue = task.due_at && new Date(task.due_at) < now
    // PR 4a: an occurrence of its own (on deck, a moved target) keeps it.
    if (kept) {
      return keepPersonalOccurrence(data, task, kept, input.rrule, anchors.anchor_time, {
        ...left,
        timezone: userTimezone,
        now,
      })
    }
    if (!willBeTracked && input.due_at === undefined && (!isOverdue || task.is_reminder)) {
      const nextOccurrence = computeFirstOccurrence(
        input.rrule,
        anchors.anchor_time,
        userTimezone,
        now,
        dayBoundaryForUser(task.user_id),
      )
      const scheduled = nextOccurrence.toISOString()
      // The target never passes the deadline (§8.2); the occurrence keeps the
      // schedule (`collectOccurrence`).
      const deadline =
        data.afterState.deadline_at !== undefined ? data.afterState.deadline_at : task.deadline_at
      const nextDueAt = capAtDeadline(scheduled, deadline ?? null, now)

      data.setClauses.push('due_at = ?')
      data.values.push(nextDueAt)
      if (!data.fieldsChanged.includes('due_at')) {
        data.fieldsChanged.push('due_at')
        data.beforeState.due_at = task.due_at
      }
      data.afterState.due_at = nextDueAt
      return { changed: true, scheduled }
    }
  }

  return { changed: true }
}

/**
 * A rule's anchor field, derived by `collectRruleChanges` (bound by position,
 * so its clause and value go together; the before value only once).
 */
function writeAnchor(
  data: FieldChangeData,
  task: Task,
  field: 'anchor_time' | 'anchor_dow' | 'anchor_dom',
  value: Task[typeof field],
): void {
  data.setClauses.push(`${field} = ?`)
  data.values.push(value)
  if (!data.fieldsChanged.includes(field)) {
    data.fieldsChanged.push(field)
    Object.assign(data.beforeState, { [field]: task[field] })
  }
  Object.assign(data.afterState, { [field]: value })
}

/** What the row a rule change leaves is (`collectRruleChanges`). */
interface RuleChangeResult {
  willBeTracked: boolean
  willBeReminder: boolean
  /** `planRepeatSchedule` decided the dates (a deadline-anchored result). */
  deadlineAnchored: boolean
}

/** Whether a rule change drops the occurrence origin (see its call in `collectRruleChanges`). */
function takesTheOrigin(
  data: FieldChangeData,
  input: FieldChangesInput,
  kept: PersonalOccurrence | null,
): boolean {
  if (kept || data.fieldsChanged.includes('original_due_at')) return false
  return input.rrule !== null || input.due_at != null
}

/**
 * PR 4a (2026-10-22; plan RT-1, ruling A1): whether a new rule KEEPS the
 * current occurrence — it is its own (`occurrenceIsPersonal`: on deck, or a
 * moved target) — and which, or null when the rule change recomputes it as
 * before: a rule cleared, over-target debt (its target is kept by the older
 * rule, its origin cleared), a row becoming a reminder or a quota, a date
 * the caller sent with the rule. On a deadline-anchored result the planner
 * sends the target on as `due_at`; it is the kept one when unchanged.
 */
function keptOccurrence(
  task: Task,
  input: FieldChangesInput,
  left: RuleChangeResult & { timezone: string; now: Date },
): PersonalOccurrence | null {
  if (!input.rrule) return null
  if (task.due_at && Date.parse(task.due_at) < left.now.getTime()) return null
  if (left.willBeTracked || left.willBeReminder || task.is_reminder) return null
  const planKept = left.deadlineAnchored && input.due_at === task.due_at
  if (input.due_at !== undefined && !planKept) return null
  const personal = occurrenceIsPersonal(task, left.timezone)
  // A target-anchored deck re-times its occurrence: none to re-time, none kept.
  if (personal === 'deck' && !left.deadlineAnchored && !task.occurrence_at) return null
  return personal
}

/**
 * What a kept occurrence (`keptOccurrence`) leaves, instead of a fresh target
 * from the rule:
 *  - a DEADLINE-ANCHORED result: `planRepeatSchedule` decided its dates (no
 *    target for a deck, `targetFor`; the moved one sent on) — nothing here;
 *  - ON DECK (target-anchored result): no target is written, so
 *    `collectDeckClear` keeps the deck; the occurrence keeps its DAY — its
 *    target's day, the derived target's on a row leaving the deadline
 *    anchor — at the new rule's time, as over-target debt does on a
 *    deadline-anchored repeat (`occurrenceFor`);
 *  - a MOVED target (target-anchored result): `due_at` stays (capped at a
 *    deadline a legacy row still carries); the occurrence moves to the new
 *    rule's first, so the move stays a move — the same "moved" rule as
 *    `targetFor`'s on the other anchor.
 * Either way `original_due_at` stays (see `rruleTakesTheOrigin`).
 */
function keepPersonalOccurrence(
  data: FieldChangeData,
  task: Task,
  personal: PersonalOccurrence,
  rrule: string,
  anchorTime: string | null,
  left: RuleChangeResult & { timezone: string; now: Date },
): RruleChange {
  if (left.deadlineAnchored) return { changed: true }
  if (personal === 'moved') {
    const deadline =
      data.afterState.deadline_at !== undefined ? data.afterState.deadline_at : task.deadline_at
    const capped = capAtDeadline(task.due_at!, deadline ?? null, left.now)
    if (capped !== task.due_at) trackField(data, 'due_at', task.due_at, capped)
    const scheduled = computeFirstOccurrence(
      rrule,
      anchorTime,
      left.timezone,
      left.now,
      dayBoundaryForUser(task.user_id),
    ).toISOString()
    return { changed: true, scheduled }
  }
  const target =
    occurrenceDates(task, task.occurrence_at!, left.timezone).targetAt ?? task.occurrence_at!
  const scheduled = occurrenceDayAtRuleTime(
    target,
    { rrule, anchor_time: anchorTime },
    left.timezone,
  )
  return { changed: true, scheduled }
}

/**
 * Collect due_at changes and detect a MOVE.
 *
 * ONE GESTURE (§6, 2026-10-12; Trent: "snooze is just retargeting"). Any date
 * change of a dated task without a schedule change is a move of its target:
 * the first-target date (`original_due_at`) is kept, and nothing else is
 * recorded — no snoozed flag, no snooze count, no snooze/re-target split
 * (old clients' `retarget` changes nothing). The visible word stays "Snooze".
 * `userMoved` says the user sent the date (the snooze stat and the "Deferred
 * to …" description); a target the server derived — the automatic one — is
 * not a move. A repeating task's move changes only `due_at`; its occurrence
 * is `collectOccurrence`'s.
 *
 * The deadline cap has already been applied (`resolveTargetInput`).
 *
 * Note: The caller is responsible for calling incrementDailyStat() when
 * isSnoozeScenario is true. This allows bulk operations to batch the stats.
 */
function collectDueAtChanges(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  rruleChanged: boolean,
  userMoved: boolean,
): void {
  // If rrule changed, due_at was handled there (if auto-computed)
  // Special case: when clearing rrule to null AND due_at to null together,
  // we need to process the explicit due_at=null here since collectRruleChanges
  // does not auto-compute due_at when clearing rrule.
  if (rruleChanged) {
    // Only process due_at if:
    // 1. rrule is being cleared to null, AND
    // 2. due_at is explicitly present in the input, AND
    // 3. due_at wasn't already processed by collectRruleChanges
    //
    // Clearing the rule is the one case where `collectRruleChanges` computes
    // nothing, so an explicit date in the same request has to be applied here
    // or it is silently dropped. That used to be limited to `due_at: null`,
    // which was enough while the only caller was "clear both"; retiring a
    // quota now injects `rrule: null` of its own accord, so
    // `{ is_tracked: false, due_at: <date> }` — retire this and give it a real
    // date — would otherwise lose the date.
    const isClearingRruleWithExplicitDueAt =
      input.rrule === null && input.due_at !== undefined && data.afterState.due_at === undefined
    if (!isClearingRruleWithExplicitDueAt) return
  }
  if (input.due_at === undefined || input.due_at === task.due_at) return

  trackField(data, 'due_at', task.due_at, input.due_at)

  // A move: a dated task's target to another date. Never when the rrule
  // changed in the same request — that is a RE-SCHEDULE (`{ rrule: null,
  // due_at: <date> }` is what the quick panel sends to clear recurrence and
  // pick a date). The first-target date is kept (set to the old target if the
  // row never had one).
  if (!rruleChanged && task.due_at !== null && input.due_at !== null) {
    data.isSnoozeScenario = userMoved
    if (task.original_due_at === null && !data.fieldsChanged.includes('original_due_at')) {
      trackField(data, 'original_due_at', null, task.due_at)
    }
  }

  // When a task with no date gets one, the occurrence origin — which is also
  // the target-age clock (2026-10-10) — starts at the new date. ALWAYS, even
  // if a stale origin is somehow still stored: a fresh target must never show
  // an age inherited from an old one ("target today" reading "14d" on day one).
  if (
    task.due_at === null &&
    input.due_at !== null &&
    task.original_due_at !== input.due_at &&
    !data.fieldsChanged.includes('original_due_at')
  ) {
    data.setClauses.push('original_due_at = ?')
    data.values.push(input.due_at)
    data.fieldsChanged.push('original_due_at')
    data.beforeState.original_due_at = task.original_due_at
    data.afterState.original_due_at = input.due_at
  }

  // When due_at is cleared to null, also clear original_due_at since the
  // occurrence origin is meaningless without a due date.
  if (input.due_at === null && task.original_due_at !== null) {
    data.setClauses.push('original_due_at = NULL')
    if (!data.fieldsChanged.includes('original_due_at')) {
      data.fieldsChanged.push('original_due_at')
      data.beforeState.original_due_at = task.original_due_at
    }
    data.afterState.original_due_at = null
  }
}
