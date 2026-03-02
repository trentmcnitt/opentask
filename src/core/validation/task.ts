/**
 * Zod validation schemas for task operations
 */

import { z } from 'zod'
import { isValidRRule } from '@/core/recurrence/rrule-builder'

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
  .refine((val) => !val || isValidRRule(val), { message: 'Invalid RRULE format' })

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
export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(10000, 'Title too long'),
  due_at: dateTimeString.nullable().optional(),
  rrule: rruleString,
  recurrence_mode: recurrenceMode.default('from_due').optional(),
  project_id: z.number().int().positive().optional(),
  priority: priority.default(0).optional(),
  labels: labels.default([]).optional(),
  notes: z.string().max(10000, 'Notes too long').nullable().optional(),
  auto_snooze_minutes: autoSnoozeMinutes.optional(),
})

export type TaskCreateInput = z.infer<typeof taskCreateSchema>

/**
 * Task update (PATCH) input schema
 * All fields optional - only included fields are updated
 */
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(10000, 'Title too long').optional(),
  due_at: dateTimeString.nullable().optional(),
  rrule: rruleString,
  recurrence_mode: recurrenceMode.optional(),
  project_id: z.number().int().positive().optional(),
  priority: priority.optional(),
  labels: labels.optional(),
  notes: z.string().max(10000, 'Notes too long').nullable().optional(),
  auto_snooze_minutes: autoSnoozeMinutes.optional(),
  reset_original_due_at: z.boolean().optional(),
})

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
})

export type BulkDoneInput = z.infer<typeof bulkDoneSchema>

/**
 * Bulk snooze input schema
 *
 * Supports two modes:
 * - Absolute: { ids, until } - sets all tasks to the same time
 * - Relative: { ids, delta_minutes } - adds minutes to each task's current due_at
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
 * Server queries overdue P0-P3 tasks for the user (P4 Urgent excluded).
 *
 * All fields are optional:
 * - `delta_minutes`: Minutes from now (with rounding: snapToHour for >= 60 min)
 * - `until`: Absolute ISO 8601 target time
 * - Neither: Uses the user's default_snooze_option preference
 *
 * `delta_minutes` and `until` are mutually exclusive.
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
  })
  .refine((data) => !(data.delta_minutes !== undefined && data.until !== undefined), {
    message: 'Cannot provide both until and delta_minutes',
  })

export type BulkSnoozeOverdueInput = z.infer<typeof bulkSnoozeOverdueSchema>

export function validateBulkSnoozeOverdue(input: unknown): BulkSnoozeOverdueInput {
  return bulkSnoozeOverdueSchema.parse(input)
}
