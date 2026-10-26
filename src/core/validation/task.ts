/**
 * Zod validation schemas for task operations
 */

import { z } from 'zod'
import { ValidationError } from '@/core/errors'
import { isValidRRule, isPeriodRRule, normalizeRRule } from '@/core/recurrence/rrule-builder'
import { MAX_REPEAT_COUNT, REPEAT_END_MESSAGES } from '@/core/tasks/repeat-schedule'

/**
 * ISO 8601 datetime string validator
 *
 * Normalizes all datetime inputs to UTC (e.g., "2026-02-22T09:00:00-06:00"
 * becomes "2026-02-22T15:00:00.000Z"). This prevents string-comparison bugs
 * in SQLite queries where a timezone-offset value like "09:00:00-06:00" would
 * sort before "14:00:00.000Z" even though it represents a later moment.
 *
 * Exported for reuse by review execute, AI schemas, and other modules that
 * write datetime values to the database.
 */
export const dateTimeString = z.string().transform((val, ctx) => {
  const d = new Date(val)
  if (isNaN(d.getTime())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid ISO 8601 datetime string',
    })
    return z.NEVER
  }
  return d.toISOString()
})

/**
 * Priority levels: 0=unset, 1=low, 2=medium, 3=high, 4=urgent
 */
const priority = z.number().int().min(0).max(4)

/**
 * Recurrence mode
 */
const recurrenceMode = z.enum(['from_due', 'from_completion'])

/**
 * Labels array — bounded to prevent resource exhaustion.
 * Max 50 labels, each 1-100 characters.
 */
const labels = z
  .array(z.string().min(1, 'Label cannot be empty').max(100, 'Label too long'))
  .max(50, 'Too many labels (max 50)')

/**
 * Opt-in to registering labels this write doesn't recognize (§7.2).
 *
 * Absent or false, an unknown label is a hard error. That is the point:
 * creating a label is a discrete act, so a typo fails loudly instead of
 * silently forking the taxonomy into a new tag.
 */
const createLabelFlag = z.boolean().optional()

/**
 * Provenance conveniences for automated callers (§7.2).
 *
 * These exist so the assistant never has to type a behavior-bearing label as
 * free text — a typo'd `ai-monitored` yields a task nobody is watching that
 * looks flagged. The flags map to `PROVENANCE_LABELS` server-side.
 */
const provenanceFlag = z.boolean().optional()

/**
 * Track target (§5): how many times this should happen per period.
 *
 * 1 means "not tracked" — every task is already a quota with target 1, so
 * tracking is opt-in simply by setting this above 1. Capped to keep a typo from
 * creating a target nobody could ever meet.
 */
const progressTarget = z.number().int().min(1).max(1000)

/** Track progress (§5): how many are logged this period. */
const progressCurrent = z.number().int().min(0).max(10000)

/**
 * §6: put this item on the Reminders surface.
 *
 * A boolean rather than a label because §7.1 rules that kind is never stored as
 * a name, and the notifier and dashboard both want an indexed column rather
 * than json_each() over the labels array.
 */
const isReminderFlag = z.boolean()

/**
 * §5/§6 are mutually exclusive: an item is tracked or it is a reminder, never
 * both. They pull in opposite directions — Track counts occurrences toward a
 * quota, while a reminder has no debt at all and completing it just means
 * "considered". A row claiming both has no coherent behavior.
 */
function refuseTrackedReminder<
  T extends { progress_target?: number; is_reminder?: boolean; is_tracked?: boolean },
>(data: T): boolean {
  return !(data.is_reminder === true && isTrackedInput(data))
}

export const TRACKED_REMINDER_MESSAGE =
  'A task cannot be both tracked (progress_target > 1) and a reminder'

/**
 * Auto-snooze minutes: null = use user default, 0 = off, 1-360 = custom minutes
 */
const autoSnoozeMinutes = z.number().int().min(0).max(360).nullable()

/**
 * RRULE string validator
 * Validates that the string is a valid RFC 5545 RRULE or null
 */
const rruleString = z
  .string()
  .nullable()
  .optional()
  .refine((val) => !val || isValidRRule(val) || isPeriodRRule(val), {
    message: 'Invalid RRULE format',
  })
  // A WEEKLY/DAILY rule's meaningless BYDAY ordinal ("1FR") is dropped, not
  // refused — `normalizeRRule`.
  .overwrite((val) => (val ? normalizeRRule(val) : val))

function isTrackedInput(data: { progress_target?: number; is_tracked?: boolean }): boolean {
  return data.is_tracked === true || (data.progress_target ?? 1) > 1
}

/**
 * A bare period rule ("FREQ=MONTHLY", no day) is a quota's rule — it names the
 * period the count runs over, not a day to occur on — so it is only valid on
 * a tracked task. On an untracked one it would land on an arbitrary weekday.
 */
function periodRuleOnlyWhenTracked<
  T extends { rrule?: string | null; progress_target?: number; is_tracked?: boolean },
>(data: T): boolean {
  if (!data.rrule || isValidRRule(data.rrule)) return true
  return isTrackedInput(data)
}
/**
 * §6: a reminder is never snoozed out of its time slot. Shared by `snoozeTask`
 * and `updateTask` (a bare `PATCH { due_at }` on a dated reminder IS a snooze —
 * it is the payload the iOS content extension snoozes with), so the two paths
 * cannot drift into saying different things.
 */
export const REMINDER_SNOOZE_MESSAGE =
  'Reminders cannot be deferred — they stay in their time slot until completed'

/**
 * §5: `done` on a quota closes its period early and zeroes the count. Nothing
 * in the app does that; an API caller almost always meant to log progress.
 */
export const QUOTA_DONE_MESSAGE =
  'This is a quota — log progress with POST /api/tasks/{id}/progress. Marking it done closes the period early and resets its count to 0; send close_period: true to do that deliberately'

export const PERIOD_RULE_MESSAGE =
  'A bare period rule (e.g. FREQ=MONTHLY) is only valid on a tracked task'

/**
 * §5: a quota is not a task, so it has no due date (Trent, 2026-09-08).
 *
 * The period a quota counts within is carried by `progress_period_start` and
 * named by the rrule's FREQ — see `period-rollover.ts`. A `due_at` on top of
 * that is a second, contradictory clock: it made the row overdue in every
 * count, offered a snooze grid, and drew a pace tick from a date that was
 * never the period boundary. Enforced in the core (create.ts and
 * collect-field-changes.ts) rather than in the Zod schema, because the schema
 * sees only the payload and "is this row a quota?" is a question about the
 * resulting row.
 */
export const QUOTA_DUE_DATE_MESSAGE =
  'A quota has no due date — it is counted within its period, not due on a day'

/**
 * §5: a quota always has a period (Trent, 2026-09-25). Its count runs over a
 * day, week, month or year named by its rule; with no rule there is no
 * boundary, so the period rollover never resets it and its prompt, once met,
 * never comes back. "Has a period" is `quotaPeriodOf(rrule) !== null` (the
 * reader every display uses). Refused on create (`createTask`) and on edit and
 * bulk edit (`collectFieldChanges`, which both go through).
 */
export const QUOTA_PERIOD_MESSAGE =
  'A quota needs a period — send rrule FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY or FREQ=YEARLY (optionally ;INTERVAL=N after it)'

/**
 * Interval quotas (2026-10-16): a quota's period spans at most 30 days, 12
 * weeks or 12 months, and a yearly one is every year — the editor's stepper
 * range (`QUOTA_INTERVAL_MAX` in `@/lib/track`, the one table both read).
 * Refused on create and on any edit that sends a rule; a stored rule outside
 * the range stays editable as long as the edit leaves the rule alone.
 */
export const QUOTA_INTERVAL_MESSAGE =
  "A quota's period can span 1–30 days, 1–12 weeks or 1–12 months; a yearly quota is every year (INTERVAL=1)"

/**
 * Short name for the quota widget chip (§5) — trimmed, capped at 24 chars so
 * it fits a small tappable chip, and an empty string clears it back to null
 * rather than storing "". Meaningful only on a quota, but accepted on any
 * task: the widget is the only thing that reads it, and rejecting it
 * elsewhere would just be a trap for a task later turned into one.
 */
// `.optional()` goes OUTSIDE `.transform()` deliberately — a transform's
// result isn't wrapped in ZodOptional, so `z.infer` marks the field required
// (present, possibly undefined) rather than omittable when `.optional()`
// comes first. `dateTimeString`, near the top of this file, has the same
// shape for the same reason.
const shortTitle = z
  .string()
  .trim()
  .max(24, 'Short name too long (max 24 characters)')
  .nullable()
  .transform((val) => (val === '' ? null : val))
  .optional()

/**
 * Quota reminders (2026-09-24): a quota's prompt settings. Every key optional —
 * an absent one takes its default — and `null` resets the whole thing to the
 * defaults. Slot ids are only shape-checked here — the schema has no user to
 * ask. Ownership is checked in core, against the quota's owner, for ids new
 * to the write (`assertPromptSlotsOwned`); a stored id whose slot was deleted
 * since still resolves at read time with fallbacks (`resolvePromptSlot`).
 */
const quotaPromptConfig = z
  .object({
    enabled: z.boolean().optional(),
    slot_id: z.number().int().positive().nullable().optional(),
    numbers: z
      .record(
        // 1..1000: a quota's target tops out at 1000 (`progressTarget`), and
        // moving a prompt row writes every number the row stands for.
        z.string().regex(/^(?:[1-9]\d{0,2}|1000)$/, 'Prompt numbers are 1 to 1000'),
        z.number().int().positive().nullable(),
      )
      .optional(),
  })
  .strict()
  .nullable()

/**
 * Task model (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * `horizon` is how soon the task should get done — its pace. It decides which
 * task segment on the reminders screen the task appears in. `null` = unset,
 * treated as weeks but never reported as set.
 */
/**
 * A deck day: a local calendar date, yyyy-MM-dd (On deck, 2026-10-20). Only
 * the shape here; "today or later" needs the owner's zone (`deckDayProblem`).
 */
const deckDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date (yyyy-MM-dd)')

/**
 * A target and a deck never travel together (rule 1: a task has one or the
 * other). A deadline may come in the same body (D2 review, 2026-10-20): the
 * Quick panel saves a staged deadline and deck as ONE write — one undo entry —
 * and the A1 rule judges the deck against the RESULTING deadline.
 */
export const DECK_WITH_DATE_MESSAGE =
  'Send on_deck_day without target_at / due_at: a task is on deck or has a target'

export const CREATE_DECK_WITH_TARGET_MESSAGE =
  'Send on_deck_day or target_at / due_at, not both: a task is on deck or has a target'

function deckAlone(data: { on_deck_day?: string | null; due_at?: string | null }): boolean {
  if (data.on_deck_day === undefined) return true
  return data.due_at === undefined
}

/**
 * A deck and a rule never travel together either (2026-10-20, repeating
 * decks): a new rule schedules its own date, which would take the deck
 * straight off. The core refuses it too (`prepareDeck`).
 */
export const DECK_WITH_RULE_MESSAGE =
  'Send on_deck_day without rrule: a new schedule sets its own date, which takes a task off deck'

function deckWithoutRule(data: { on_deck_day?: string | null; rrule?: string | null }): boolean {
  return typeof data.on_deck_day !== 'string' || data.rrule === undefined
}

/**
 * DEADLINE-ANCHORED REPEATS (2026-10-21, docs/TASK-MODEL.md § Recurrence
 * Model): what a repeating task's occurrence is, and where its target sits
 * before a deadline occurrence. Only the shapes here; the cross-field rules
 * (a rule and a deadline, never a reminder or quota, the target before the
 * deadline and after the previous one) need the row and the owner's zone —
 * `src/core/tasks/repeat-schedule.ts`.
 */
const repeatAnchor = z.enum(['target', 'deadline'])
const targetDaysBefore = z.number().int().min(0).max(366)
/**
 * The deadlines page's lead override (2026-10-22): local days before the
 * deadline's day a deadline task with no target goes on the page; null = the
 * default table. Clamped to D−1 at the near end (`leadFrom`).
 */
const leadDays = z.number().int().min(1).max(90)
const targetTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time (HH:MM)')
/**
 * Relative targets (2026-10-24): the reminder period a relative target's time
 * follows — one of the task OWNER's (checked in core, which knows the owner);
 * it sets `target_time` to the period's start. Null = a custom time.
 */
const targetSlotId = z.number().int().positive()

/**
 * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends): "After N
 * times" and "On date" (a local calendar date). Only the shapes here; the
 * rest — a rule, the row's kind, N above the used count, the date today or
 * later and not before the occurrence — needs the row and the owner's zone
 * (`repeatEndProblem`, src/core/tasks/repeat-schedule.ts). COUNT / UNTIL
 * sent inside `rrule` are lifted into these first (`liftRuleEnd`).
 */
const repeatCount = z
  .number({ message: REPEAT_END_MESSAGES.count_range })
  .int(REPEAT_END_MESSAGES.count_range)
  .min(1, REPEAT_END_MESSAGES.count_range)
  .max(MAX_REPEAT_COUNT, REPEAT_END_MESSAGES.count_range)
  .nullable()
const repeatUntil = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, REPEAT_END_MESSAGES.until_invalid)
  .nullable()

/** A bulk edit never sets an end (A11). */
export const BULK_ENDS_MESSAGE =
  'Repeat ends are set per task: send repeat_count / repeat_until (or COUNT / UNTIL in rrule) to PATCH /api/tasks/{id}'

function oneEnd(data: { repeat_count?: number | null; repeat_until?: string | null }): boolean {
  return !(data.repeat_count != null && data.repeat_until != null)
}

export const HORIZONS = ['days', 'weeks', 'months', 'eventually'] as const
export type Horizon = (typeof HORIZONS)[number]
const horizon = z.enum(HORIZONS).nullable()

/**
 * Bulk operation ID array — bounded to prevent DoS via excessive DB queries.
 */
const bulkIds = z
  .array(z.number().int().positive())
  .min(1, 'At least one task ID required')
  .max(500, 'Too many task IDs (max 500)')

/**
 * Task creation input schema
 */
export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(10000, 'Title too long'),
    short_title: shortTitle,
    due_at: dateTimeString.nullable().optional(),
    deadline_at: dateTimeString.nullable().optional(),
    horizon: horizon.optional(),
    rrule: rruleString,
    recurrence_mode: recurrenceMode.default('from_due').optional(),
    // 2026-10-21: a rule with a deadline_at is deadline-anchored unless this
    // says otherwise; target_days_before / target_time default (`createTask`).
    // 2026-10-24: on a one-off with a deadline, they make its target relative.
    repeat_anchor: repeatAnchor.optional(),
    target_days_before: targetDaysBefore.optional(),
    target_time: targetTime.optional(),
    // Relative targets (2026-10-24): the period the time follows (`target_slot_id`).
    target_slot_id: targetSlotId.nullable().optional(),
    // The deadlines page (2026-10-22): the lead override; null = the default.
    lead_days: leadDays.nullable().optional(),
    // Repeat ends (2026-10-22): one or the other; checked in `createTask`.
    repeat_count: repeatCount.optional(),
    repeat_until: repeatUntil.optional(),
    project_id: z.number().int().positive().optional(),
    priority: priority.default(0).optional(),
    labels: labels.default([]).optional(),
    notes: z.string().max(10000, 'Notes too long').nullable().optional(),
    auto_snooze_minutes: autoSnoozeMinutes.optional(),
    create_label: createLabelFlag,
    ai_proposed: provenanceFlag,
    ai_added: provenanceFlag,
    progress_target: progressTarget.optional(),
    is_reminder: isReminderFlag.optional(),
    is_tracked: z.boolean().optional(),
    quota_prompt_config: quotaPromptConfig.optional(),
    // Ask for AI enrichment even though the caller supplied structured fields
    // (which would otherwise disqualify it from the title-only trigger). The
    // Reminders quick add sets it. Note on `rrule` above for a reminder:
    // OMITTED means "put it in my default reminder slot" (createTask), while
    // an explicit null means "no schedule" (the editor's one-time thought).
    enrich: z.boolean().optional(),
    // WAIT (2026-10-24, quota enrichment): the response waits — up to a cap —
    // for the enrichment this create starts, and carries what it did (`ai`).
    // For a one-shot caller like an Apple Shortcut, which never sees the
    // sync event. Never stored. See POST /api/tasks.
    wait: z.boolean().optional(),
    // ON DECK (2026-10-20): create the task on deck for this local calendar
    // date. One-offs only, today or later, the A1 rule against any deadline
    // in the same body — checked in `createTask`. Never with a target.
    on_deck_day: deckDay.nullable().optional(),
  })
  .refine(refuseTrackedReminder, { message: TRACKED_REMINDER_MESSAGE })
  .refine(oneEnd, { message: REPEAT_END_MESSAGES.both_ends, path: ['repeat_count'] })
  .refine((data) => !(data.on_deck_day && data.due_at !== undefined && data.due_at !== null), {
    message: CREATE_DECK_WITH_TARGET_MESSAGE,
    path: ['on_deck_day'],
  })
  .refine(periodRuleOnlyWhenTracked, { message: PERIOD_RULE_MESSAGE, path: ['rrule'] })

export type TaskCreateInput = z.infer<typeof taskCreateSchema>

/**
 * Task update (PATCH) input schema
 * All fields optional - only included fields are updated
 */
export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(10000, 'Title too long').optional(),
    short_title: shortTitle,
    due_at: dateTimeString.nullable().optional(),
    deadline_at: dateTimeString.nullable().optional(),
    horizon: horizon.optional(),
    // Process "keep" (2026-10-10): re-affirm the current horizon — restart its
    // growth clock (`horizon_set_at`) without changing it. Needed because
    // sending the same horizon is a no-op, and an unset horizon must stay unset.
    affirm_horizon: z.boolean().optional(),
    // RETIRED 2026-10-12 (§8): accepted from old clients and ignored. An old
    // "Remove target" sends it with `due_at: null`, which on a deadline task
    // now means "back to the automatic target".
    deadline_nag_off: z.boolean().optional(),
    rrule: rruleString,
    recurrence_mode: recurrenceMode.optional(),
    // 2026-10-21: switching the anchor needs `rrule` in the same body; the
    // offsets are null only on a target-anchored result (`planRepeatSchedule`).
    repeat_anchor: repeatAnchor.optional(),
    target_days_before: targetDaysBefore.nullable().optional(),
    target_time: targetTime.nullable().optional(),
    // Relative targets (2026-10-24): on a one-off with a deadline too. The
    // period the time follows; `target_time` alone is a custom time.
    target_slot_id: targetSlotId.nullable().optional(),
    // The deadlines page (2026-10-22): the lead override (series-level on a
    // repeat); null = the default table. Re-derives `lead_from`.
    lead_days: leadDays.nullable().optional(),
    // Repeat ends (2026-10-22): setting one clears the other; null clears it;
    // `rrule: null` clears both (`collectRepeatEnds`).
    repeat_count: repeatCount.optional(),
    repeat_until: repeatUntil.optional(),
    project_id: z.number().int().positive().optional(),
    priority: priority.optional(),
    labels: labels.optional(),
    notes: z.string().max(10000, 'Notes too long').nullable().optional(),
    auto_snooze_minutes: autoSnoozeMinutes.optional(),
    // §6 (2026-10-12, ruling Q4): there is no snooze/re-target split any more —
    // every date change is one "move target". `retarget` (alias
    // `reset_original_due_at`), `allow_past_deadline` and `cap_at_deadline`
    // are accepted from old clients and change nothing: a move is a move,
    // always capped at the deadline. The one meaning `reset_original_due_at`
    // keeps is on a REMINDER, where it is the explicit reschedule a period
    // move sends (a reminder is never snoozed).
    reset_original_due_at: z.boolean().optional(),
    allow_past_deadline: z.boolean().optional(),
    cap_at_deadline: z.boolean().optional(),
    create_label: createLabelFlag,
    progress_target: progressTarget.optional(),
    progress_current: progressCurrent.optional(),
    is_reminder: isReminderFlag.optional(),
    is_tracked: z.boolean().optional(),
    quota_prompt_config: quotaPromptConfig.optional(),
    // ON DECK (2026-10-20, docs/TASK-MODEL.md § On deck): the local calendar
    // date (yyyy-MM-dd) to put the task on deck for; null takes it off deck.
    // Today or later, one-offs only, and the A1 deadline rule — checked in
    // `collectFieldChanges`, which knows the task and the owner's zone.
    on_deck_day: deckDay.nullable().optional(),
  })
  // A PATCH carrying a bare period rule must say the task is tracked in the
  // same request (is_tracked or progress_target); the schema has no task to ask.
  .refine(periodRuleOnlyWhenTracked, { message: PERIOD_RULE_MESSAGE, path: ['rrule'] })
  .refine(oneEnd, { message: REPEAT_END_MESSAGES.both_ends, path: ['repeat_count'] })
  .refine(deckAlone, { message: DECK_WITH_DATE_MESSAGE, path: ['on_deck_day'] })
  .refine(deckWithoutRule, { message: DECK_WITH_RULE_MESSAGE, path: ['on_deck_day'] })

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>

/**
 * Snooze input schema
 */
export const snoozeSchema = z.object({
  until: dateTimeString,
  allow_past_deadline: z.boolean().optional(),
  cap_at_deadline: z.boolean().optional(),
})

export type SnoozeInput = z.infer<typeof snoozeSchema>

/**
 * Bulk done input schema
 */
export const bulkDoneSchema = z.object({
  ids: bulkIds,
  // §5: also complete any quotas in the batch (closing each period early and
  // resetting its count). Without it, quotas are skipped — see `bulkDone`.
  close_period: z.boolean().optional(),
})

export type BulkDoneInput = z.infer<typeof bulkDoneSchema>

/**
 * Bulk snooze input schema
 *
 * Supports two modes:
 * - Absolute: { ids, until } - sets all tasks to the same time
 * - Relative: { ids, delta_minutes } - adds minutes to each task's current due_at
 *
 * `include_task_ids` bypasses the default P3/P4 (High/Urgent) skip filter for
 * the listed task IDs. Explicit user selections (e.g., the mobile selection
 * sheet's quick panel) pass this so high/urgent tasks the user has deliberately
 * picked are not silently dropped. The "Snooze All Overdue" sweep omits it,
 * preserving the default behavior of leaving high/urgent tasks alone.
 */
export const bulkSnoozeSchema = z
  .object({
    ids: bulkIds,
    until: dateTimeString.optional(),
    delta_minutes: z
      .number()
      .int()
      .min(-1440, 'Cannot go back more than 24 hours')
      .max(525600, 'Cannot defer more than 1 year')
      .optional(),
    include_task_ids: z.array(z.number().int().positive()).max(500).optional(),
    // Accepted from old clients and ignored (2026-10-12): every move is
    // capped at its deadline (§8.2).
    allow_past_deadline_ids: z.array(z.number().int().positive()).max(500).optional(),
    cap_at_deadline_ids: z.array(z.number().int().positive()).max(500).optional(),
    /**
     * PICK OR DEFER (task queue, 2026-10-19; docs/TASK-MODEL.md § Picks and
     * defers). Absent = a pick, as always. `sweep` = Snooze-all (the web
     * clock and FAB send it); `try_tomorrow` = Try Tomorrow on one task, which
     * needs no `until` / `delta_minutes` (it lands on the next rollover).
     */
    source: z.enum(['sweep', 'try_tomorrow']).optional(),
  })
  .refine(
    (data) =>
      data.until !== undefined ||
      data.delta_minutes !== undefined ||
      data.source === 'try_tomorrow',
    { message: 'Either until or delta_minutes must be provided' },
  )
  .refine((data) => !(data.until !== undefined && data.delta_minutes !== undefined), {
    message: 'Cannot provide both until and delta_minutes',
  })

export type BulkSnoozeInput = z.infer<typeof bulkSnoozeSchema>

/**
 * Bulk edit input schema
 *
 * For labels, supports three modes:
 * - labels: Replaces labels entirely (existing behavior)
 * - labels_add: Adds labels to each task's existing labels
 * - labels_remove: Removes labels from each task's existing labels
 */
export const bulkEditSchema = z
  .object({
    ids: bulkIds,
    changes: taskUpdateSchema.extend({
      labels_add: labels.optional(),
      labels_remove: labels.optional(),
    }),
    /**
     * Values that legitimately differ from task to task within ONE gesture,
     * keyed by task id and merged over `changes` for that task. The case that
     * needs it: moving several reminders to another time slot rewrites each
     * one's own rule (daily, Tue/Thu, monthly) with the new time — one request,
     * one Undo. Only the schedule is per-task; everything else stays shared.
     */
    per_task: z
      .record(z.string().regex(/^\d+$/, 'Task id'), z.object({ rrule: rruleString }).strict())
      .optional(),
    /**
     * One save, one undo (2026-09-27): the multi-select quick panel sends a date
     * AND other fields in this one request rather than splitting the date off
     * to bulk/snooze. These three carry what bulk/snooze's body used to:
     * - `include_task_ids`: explicit picks the High/Urgent sweep filter keeps.
     * - `delta_minutes`: a relative move of each task's own date (instead of
     *   `changes.due_at`); a task with no date keeps the rest of the edit.
     * - `date_task_ids`: the date applies to these ids only — the rest of the
     *   edit still applies to every id.
     */
    include_task_ids: z.array(z.number().int().positive()).max(500).optional(),
    delta_minutes: z
      .number()
      .int()
      .min(-1440, 'Cannot go back more than 24 hours')
      .max(525600, 'Cannot defer more than 1 year')
      .optional(),
    date_task_ids: z.array(z.number().int().positive()).max(500).optional(),
    allow_past_deadline_ids: z.array(z.number().int().positive()).max(500).optional(),
    cap_at_deadline_ids: z.array(z.number().int().positive()).max(500).optional(),
  })
  .refine((data) => !(data.delta_minutes !== undefined && data.changes.due_at !== undefined), {
    message: 'Cannot provide both changes.due_at and delta_minutes',
  })
  // On deck: a relative move is a target too (rule 1, never both).
  .refine((data) => !(data.delta_minutes !== undefined && data.changes.on_deck_day !== undefined), {
    message: DECK_WITH_DATE_MESSAGE,
    path: ['changes', 'on_deck_day'],
  })
  // Repeat ends (2026-10-22, A11): ends are set per task — one bulk "6 more"
  // would give every task its own six.
  .refine(
    (data) => data.changes.repeat_count === undefined && data.changes.repeat_until === undefined,
    { message: BULK_ENDS_MESSAGE, path: ['changes', 'repeat_count'] },
  )

export type BulkEditInput = z.infer<typeof bulkEditSchema>

/**
 * Task segment actions (2026-10-10): consider, defer, target today. Body:
 * `{ ids: [taskId, ...] }` — the caller's own open tasks only.
 */
export const segmentIdsSchema = z.object({ ids: bulkIds })

/**
 * POST /api/tasks/deck (On deck, 2026-10-20): `{ ids, day? }`. `day` is the
 * local calendar date (yyyy-MM-dd); omitted = today; null = take off deck.
 */
export const deckSchema = z.object({ ids: bulkIds, day: deckDay.nullable().optional() })

export function validateDeck(input: unknown): { ids: number[]; day?: string | null } {
  return deckSchema.parse(input)
}

/**
 * POST /api/task-segments/defer-lead (the deadlines page, 2026-10-22):
 * `{ ids, day? }` — `day` the OpenTask day (yyyy-MM-dd) the lead moves to;
 * omitted = tomorrow.
 */
export const deferLeadSchema = z.object({ ids: bulkIds, day: deckDay.optional() })

export function validateDeferLead(input: unknown): { ids: number[]; day?: string } {
  return deferLeadSchema.parse(input)
}

export function validateSegmentIds(input: unknown): { ids: number[] } {
  return segmentIdsSchema.parse(input)
}

/**
 * Target today (2026-10-12): the ids, and optionally `at` — the moment the
 * Today button's time picker chose (any ISO 8601 datetime, stored as UTC).
 * Omitted, the server picks `targetTodayTime`. "Today or later" is checked in
 * `targetTasksToday`, which knows the user's timezone.
 */
export const segmentTargetSchema = z.object({ ids: bulkIds, at: dateTimeString.optional() })

export function validateSegmentTarget(input: unknown): { ids: number[]; at?: string } {
  return segmentTargetSchema.parse(input)
}

/**
 * Skip until (task queue PR 4): the ids, and optionally `until` — a local day
 * (`yyyy-MM-dd`). Omitted or null: skip this occurrence. Whether the day is
 * real, not in the past and not too far is checked in `skipUntil`, which knows
 * the user's timezone.
 */
export const bulkSkipUntilSchema = z.object({
  ids: bulkIds,
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'until must be a date (yyyy-MM-dd)')
    .nullable()
    .optional(),
})

export function validateBulkSkipUntil(input: unknown): z.infer<typeof bulkSkipUntilSchema> {
  return bulkSkipUntilSchema.parse(input)
}

/**
 * Bulk delete input schema
 */
export const bulkDeleteSchema = z.object({
  ids: bulkIds,
})

export type BulkDeleteInput = z.infer<typeof bulkDeleteSchema>

/**
 * Validate and transform input
 */
/**
 * The target's API names (2026-10-10). `target_at` is the primary name for the
 * target and `due_at` its deprecated alias — older native builds, Shortcuts
 * and the desks send `due_at`, so both are accepted and both are returned
 * (`formatTaskResponse`). Likewise `retarget: true` for
 * `reset_original_due_at: true` (since 2026-10-12 ignored on a task — a move
 * is a move — and the explicit reschedule on a reminder). The column is still
 * `due_at`; this only maps the names.
 * Sending both names with different values is refused rather than guessed.
 */
export function normalizeTargetAliases(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const alias = (primary: string, legacy: string) => {
    if (!(primary in out)) return
    if (legacy in out && JSON.stringify(out[legacy]) !== JSON.stringify(out[primary])) {
      throw new ValidationError(`Send ${primary} or ${legacy}, not both with different values`)
    }
    out[legacy] = out[primary]
    delete out[primary]
  }
  alias('target_at', 'due_at')
  alias('retarget', 'reset_original_due_at')
  return out
}

export const RULE_END_CONFLICT_MESSAGE =
  'The rule says one end and repeat_count / repeat_until another: send the end once'

/** The rule's COUNT / UNTIL, if any, and the rule without them. */
function splitRuleEnd(rrule: string): {
  rule: string
  count: number | null | undefined
  until: string | null | undefined
} {
  let count: number | null | undefined
  let until: string | null | undefined
  const kept: string[] = []
  for (const part of rrule.split(';')) {
    const [key, value = ''] = part.split('=')
    const name = key.trim().toUpperCase()
    if (name === 'COUNT') {
      if (!/^\d+$/.test(value.trim())) throw new ValidationError(REPEAT_END_MESSAGES.count_range)
      count = parseInt(value, 10)
    } else if (name === 'UNTIL') {
      // YYYYMMDD taken LITERALLY as the local last day, with or without a
      // time ("T235959Z" is the end of the day in UTC, which is the wrong
      // day in most zones — the date is what the caller picked).
      const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/i)
      if (!m) throw new ValidationError(REPEAT_END_MESSAGES.until_invalid)
      until = `${m[1]}-${m[2]}-${m[3]}`
    } else kept.push(part)
  }
  return { rule: kept.join(';'), count, until }
}

/** Whether a rule carries COUNT or UNTIL. */
export function ruleHasEnd(rrule: unknown): boolean {
  return typeof rrule === 'string' && /(^|;)\s*(COUNT|UNTIL)=/i.test(rrule)
}

/**
 * REPEAT ENDS SENT AS SHORTHAND (2026-10-22): COUNT / UNTIL inside an
 * incoming `rrule` — the legacy picker, the editor's draft and RFC clients
 * send them that way — are LIFTED into `repeat_count` / `repeat_until`, and
 * the rule is stored end-free. Runs before the rule is validated
 * (`isValidRRule` refuses a stored rule with an end, so a past UNTIL would
 * otherwise read as "Invalid RRULE format"). An end the same body also sends
 * as a field must agree (else 400); COUNT and UNTIL together are `both_ends`.
 * A rule sent WITHOUT an end leaves the stored end alone: responses return
 * the rule end-free, so a client echoing it back must not wipe the end.
 */
export function liftRuleEnd(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const body = input as Record<string, unknown>
  if (!ruleHasEnd(body.rrule)) return input
  const { rule, count, until } = splitRuleEnd(body.rrule as string)
  if (count !== undefined && until !== undefined) {
    throw new ValidationError(REPEAT_END_MESSAGES.both_ends)
  }
  const out: Record<string, unknown> = { ...body, rrule: rule }
  const lift = (field: 'repeat_count' | 'repeat_until', value: unknown) => {
    if (field in body && body[field] !== value) throw new ValidationError(RULE_END_CONFLICT_MESSAGE)
    out[field] = value
  }
  if (count !== undefined) lift('repeat_count', count)
  if (until !== undefined) lift('repeat_until', until)
  return out
}

export function validateTaskCreate(input: unknown): TaskCreateInput {
  return taskCreateSchema.parse(liftRuleEnd(normalizeTargetAliases(input)))
}

export function validateTaskUpdate(input: unknown): TaskUpdateInput {
  return taskUpdateSchema.parse(liftRuleEnd(normalizeTargetAliases(input)))
}

export function validateSnooze(input: unknown): SnoozeInput {
  return snoozeSchema.parse(input)
}

export function validateBulkDone(input: unknown): BulkDoneInput {
  return bulkDoneSchema.parse(input)
}

export function validateBulkSnooze(input: unknown): BulkSnoozeInput {
  return bulkSnoozeSchema.parse(input)
}

export function validateBulkEdit(input: unknown): BulkEditInput {
  // Repeat ends are set per task (A11): an end inside a shared or per-task
  // rule is refused with the reason, not "Invalid RRULE format".
  if (input && typeof input === 'object') {
    const { changes, per_task } = input as { changes?: { rrule?: unknown }; per_task?: unknown }
    const perTask =
      per_task && typeof per_task === 'object'
        ? Object.values(per_task as Record<string, { rrule?: unknown } | null>)
        : []
    if (ruleHasEnd(changes?.rrule) || perTask.some((p) => ruleHasEnd(p?.rrule))) {
      throw new ValidationError(BULK_ENDS_MESSAGE)
    }
  }
  const body =
    input && typeof input === 'object' && 'changes' in input
      ? {
          ...(input as Record<string, unknown>),
          changes: normalizeTargetAliases((input as { changes: unknown }).changes),
        }
      : input
  return bulkEditSchema.parse(body)
}

export function validateBulkDelete(input: unknown): BulkDeleteInput {
  return bulkDeleteSchema.parse(input)
}

/**
 * Bulk snooze-overdue input schema
 *
 * Server-side convenience for the iOS "All" button — no task IDs needed.
 * Server queries overdue P0-P2 tasks for the user (P3 High and P4 Urgent excluded).
 *
 * All fields are optional:
 * - `delta_minutes`: Minutes from now (with rounding: snapToHour for >= 60 min)
 * - `until`: Absolute ISO 8601 target time
 * - `slot`: A time slot to snooze to — its `start_time` ("HH:MM"), or "next"
 *   for the next period. The server resolves it in the user's timezone: see
 *   `nextSlotStart` / `nextPeriodStart`. Clients never compute the time, so a
 *   phone on a different clock cannot send a wrong one.
 * - None: Uses the user's default_snooze_option preference
 *
 * `delta_minutes`, `until` and `slot` are mutually exclusive.
 */
export const bulkSnoozeOverdueSchema = z
  .object({
    delta_minutes: z
      .number()
      .int()
      .min(1, 'delta_minutes must be positive')
      .max(525600, 'Cannot defer more than 1 year')
      .optional(),
    until: dateTimeString.optional(),
    slot: z
      .union([
        z.literal('next'),
        z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'slot must be HH:MM or "next"'),
      ])
      .optional(),
    /**
     * Tomorrow at the user's morning time (the `'tomorrow'` snooze option),
     * resolved on the server like `slot`. The iPhone's "Snooze All to
     * Tomorrow" quick action sends it (2026-09-28); before this field it sent
     * an empty body, which meant the user's default option — +1 hour for
     * most users, not tomorrow.
     */
    tomorrow: z.literal(true).optional(),
    include_task_ids: z.array(z.number().int().positive()).max(10).optional(),
    /**
     * `false` suppresses the bulk snooze feedback push for this one call
     * (`src/core/notifications/sweep-feedback.ts`) — for a caller that shows
     * the result itself: the iPhone's Home Screen quick actions (the app opens
     * and shows the toast), or a Shortcut that displays `data.message`.
     */
    notify: z.boolean().optional(),
  })
  .refine(
    (data) =>
      [data.delta_minutes, data.until, data.slot, data.tomorrow].filter((v) => v !== undefined)
        .length <= 1,
    { message: 'Provide at most one of until, delta_minutes, slot and tomorrow' },
  )

export type BulkSnoozeOverdueInput = z.infer<typeof bulkSnoozeOverdueSchema>

export function validateBulkSnoozeOverdue(input: unknown): BulkSnoozeOverdueInput {
  return bulkSnoozeOverdueSchema.parse(input)
}
