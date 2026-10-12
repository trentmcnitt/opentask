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
import { deriveAnchorFields, computeFirstOccurrence } from '@/core/recurrence'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import {
  QUOTA_DUE_DATE_MESSAGE,
  QUOTA_PERIOD_MESSAGE,
  REMINDER_SNOOZE_MESSAGE,
  TRACKED_REMINDER_MESSAGE,
} from '@/core/validation'
import { isTracked, quotaPeriodOf } from '@/lib/track'
import { capAtDeadline, resolveTarget, type TargetContext } from '@/lib/task-segments'
import { getTargetContext } from '../target-context'
import { assertPromptSlotsOwned } from '@/core/time-slots'
import { stampTargetSet } from '../target-set'

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
   * the description "Snoozed to …". Not a first date, a clear, a schedule
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
  const retired: FieldChangesInput =
    wasTracked && !willBeTracked && options.input.rrule === undefined
      ? { ...options.input, rrule: null }
      : options.input
  const target = resolveTargetInput(task, retired, {
    willBeTracked,
    willBeReminder,
    ctx: options.targetCtx ?? getTargetContext(task.user_id),
    now,
  })
  const input = target.input

  const data: FieldChangeData = {
    setClauses: [],
    values: [],
    fieldsChanged: [],
    beforeState: { id: task.id, title: task.title },
    afterState: { id: task.id, title: task.title },
    isSnoozeScenario: false,
    cappedAtDeadline: target.capped,
  }

  // Track basic field changes
  collectBasicFields(data, task, input, userId, skipProjectValidation, willBeReminder)
  collectTaskModelFields(data, task, input, now)
  collectQuotaPromptFields(data, task, input)

  // Track rrule changes with anchor derivation
  const rrule = collectRruleChanges(data, task, input, userTimezone, now, willBeTracked)

  // Track due_at changes and move detection. Only a date the USER sent is a
  // move — not a clear, and not the automatic target the server put in its
  // place (a deadline edit, "Back to auto").
  const userMoved = retired.due_at !== undefined && retired.due_at !== null
  collectDueAtChanges(
    data,
    task,
    input,
    rrule.changed,
    userMoved && !(willBeReminder && reschedulesReminder(input)),
  )

  // §6: a repeating task's scheduled occurrence, apart from its target.
  collectOccurrence(data, task, input, rrule, willBeTracked, willBeReminder)
  // §8: whether the target the write leaves is the deadline's automatic one.
  if (target.auto !== task.target_auto) {
    trackField(data, 'target_auto', task.target_auto, target.auto, undefined, target.auto ? 1 : 0)
  }

  // Whatever date the row still carried, drop it if it is (or is becoming) a quota
  collectQuotaDateClear(data, task, willBeTracked)

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

  // Upcoming (2026-10-12): any change to the target or the deadline restarts
  // the wait its heads-ups are counted over (`src/core/tasks/target-set.ts`).
  // Last, once everything above has decided `due_at` and `deadline_at`.
  stampTargetSet(data, task, now.toISOString())

  return data
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
  opts: { willBeTracked: boolean; willBeReminder: boolean; ctx: TargetContext; now: Date },
): { input: FieldChangesInput; auto: boolean; capped: boolean } {
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
    },
    opts.ctx,
    opts.now,
  )
  const out = resolved.dueAt === left ? input : { ...input, due_at: resolved.dueAt }
  return { input: out, auto: resolved.auto, capped: resolved.capped && dueWritten }
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
 * - a one-off (or a quota) has none.
 */
function collectOccurrence(
  data: FieldChangeData,
  task: Task,
  input: FieldChangesInput,
  rrule: RruleChange,
  willBeTracked: boolean,
  willBeReminder: boolean,
): void {
  const resultingRule = input.rrule !== undefined ? input.rrule : task.rrule
  const dueAfter = data.afterState.due_at !== undefined ? data.afterState.due_at : task.due_at
  let next: string | null
  if (!resultingRule || willBeTracked) next = null
  else if (rrule.changed) next = rrule.scheduled ?? dueAfter ?? null
  else if (willBeReminder) next = dueAfter ?? null
  else if (task.occurrence_at === null && data.fieldsChanged.includes('due_at')) {
    next = task.due_at ?? dueAfter ?? null
  } else return
  if (next !== task.occurrence_at) trackField(data, 'occurrence_at', task.occurrence_at, next)
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
  willBeTracked: boolean,
): RruleChange {
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
  const rruleTakesTheOrigin =
    !data.fieldsChanged.includes('original_due_at') &&
    (input.rrule !== null || input.due_at != null)

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

    // Update anchor_time
    data.setClauses.push('anchor_time = ?')
    data.values.push(anchors.anchor_time)
    if (!data.fieldsChanged.includes('anchor_time')) {
      data.fieldsChanged.push('anchor_time')
      data.beforeState.anchor_time = task.anchor_time
    }
    data.afterState.anchor_time = anchors.anchor_time

    // Update anchor_dow
    data.setClauses.push('anchor_dow = ?')
    data.values.push(anchors.anchor_dow)
    if (!data.fieldsChanged.includes('anchor_dow')) {
      data.fieldsChanged.push('anchor_dow')
      data.beforeState.anchor_dow = task.anchor_dow
    }
    data.afterState.anchor_dow = anchors.anchor_dow

    // Update anchor_dom
    data.setClauses.push('anchor_dom = ?')
    data.values.push(anchors.anchor_dom)
    if (!data.fieldsChanged.includes('anchor_dom')) {
      data.fieldsChanged.push('anchor_dom')
      data.beforeState.anchor_dom = task.anchor_dom
    }
    data.afterState.anchor_dom = anchors.anchor_dom

    // Only auto-compute due_at if:
    // 1. User didn't explicitly pass due_at
    // 2. Task is NOT overdue (due_at is in the future or null) — an overdue
    //    task keeps its overdue date so a schedule edit cannot quietly clear
    //    debt the user still has to sweep.
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
    if (!willBeTracked && input.due_at === undefined && (!isOverdue || task.is_reminder)) {
      const nextOccurrence = computeFirstOccurrence(input.rrule, anchors.anchor_time, userTimezone)
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
 * Collect due_at changes and detect a MOVE.
 *
 * ONE GESTURE (§6, 2026-10-12; Trent: "snooze is just retargeting"). Any date
 * change of a dated task without a schedule change is a move of its target:
 * the first-target date (`original_due_at`) is kept, and nothing else is
 * recorded — no snoozed flag, no snooze count, no snooze/re-target split
 * (old clients' `retarget` changes nothing). The visible word stays "Snooze".
 * `userMoved` says the user sent the date (the snooze stat and the "Snoozed
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
