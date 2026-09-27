/**
 * Zod validation schemas for task operations
 */

import { z } from 'zod'
import { isValidRRule, isPeriodRRule } from '@/core/recurrence/rrule-builder'

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
  'Reminders cannot be snoozed — they stay in their time slot until completed'

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
  'A quota needs a period — send rrule FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY or FREQ=YEARLY'

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
    rrule: rruleString,
    recurrence_mode: recurrenceMode.default('from_due').optional(),
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
    // Ask for AI enrichment even though the caller supplied structured fields.
    // The Reminders quick add sets it: it always sends a sensible default
    // schedule so the row lands in a slot immediately, which would otherwise
    // disqualify it from the title-only enrichment trigger.
    enrich: z.boolean().optional(),
  })
  .refine(refuseTrackedReminder, { message: TRACKED_REMINDER_MESSAGE })
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
    rrule: rruleString,
    recurrence_mode: recurrenceMode.optional(),
    project_id: z.number().int().positive().optional(),
    priority: priority.optional(),
    labels: labels.optional(),
    notes: z.string().max(10000, 'Notes too long').nullable().optional(),
    auto_snooze_minutes: autoSnoozeMinutes.optional(),
    reset_original_due_at: z.boolean().optional(),
    create_label: createLabelFlag,
    progress_target: progressTarget.optional(),
    progress_current: progressCurrent.optional(),
    is_reminder: isReminderFlag.optional(),
    is_tracked: z.boolean().optional(),
    quota_prompt_config: quotaPromptConfig.optional(),
  })
  // A PATCH carrying a bare period rule must say the task is tracked in the
  // same request (is_tracked or progress_target); the schema has no task to ask.
  .refine(periodRuleOnlyWhenTracked, { message: PERIOD_RULE_MESSAGE, path: ['rrule'] })

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>

/**
 * Snooze input schema
 */
export const snoozeSchema = z.object({
  until: dateTimeString,
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
      .max(525600, 'Cannot snooze more than 1 year')
      .optional(),
    include_task_ids: z.array(z.number().int().positive()).max(500).optional(),
  })
  .refine((data) => data.until !== undefined || data.delta_minutes !== undefined, {
    message: 'Either until or delta_minutes must be provided',
  })
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
export const bulkEditSchema = z.object({
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
})

export type BulkEditInput = z.infer<typeof bulkEditSchema>

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
export function validateTaskCreate(input: unknown): TaskCreateInput {
  return taskCreateSchema.parse(input)
}

export function validateTaskUpdate(input: unknown): TaskUpdateInput {
  return taskUpdateSchema.parse(input)
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
  return bulkEditSchema.parse(input)
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
      .max(525600, 'Cannot snooze more than 1 year')
      .optional(),
    until: dateTimeString.optional(),
    slot: z
      .union([
        z.literal('next'),
        z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'slot must be HH:MM or "next"'),
      ])
      .optional(),
    include_task_ids: z.array(z.number().int().positive()).max(10).optional(),
  })
  .refine(
    (data) =>
      [data.delta_minutes, data.until, data.slot].filter((v) => v !== undefined).length <= 1,
    { message: 'Provide at most one of until, delta_minutes and slot' },
  )

export type BulkSnoozeOverdueInput = z.infer<typeof bulkSnoozeOverdueSchema>

export function validateBulkSnoozeOverdue(input: unknown): BulkSnoozeOverdueInput {
  return bulkSnoozeOverdueSchema.parse(input)
}
