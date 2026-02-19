/**
 * Zod validation schemas for task operations
 */

import { z } from 'zod'
import { isValidRRule } from '@/core/recurrence/rrule-builder'

/**
 * ISO 8601 datetime string validator
 */
const dateTimeString = z.string().refine(
  (val) => {
    const d = new Date(val)
    return !isNaN(d.getTime())
  },
  { message: 'Invalid ISO 8601 datetime string' },
)

/**
 * Priority levels: 0=unset, 1=low, 2=medium, 3=high, 4=urgent
 */
const priority = z.number().int().min(0).max(4)

/**
 * Recurrence mode
 */
const recurrenceMode = z.enum(['from_due', 'from_completion'])

/**
 * Labels array
 */
const labels = z.array(z.string())

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
 * Task creation input schema
 */
export const taskCreateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(10000, 'Title too long'),
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
  title: z.string().min(1, 'Title is required').max(10000, 'Title too long').optional(),
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
  ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
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
    ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
    until: dateTimeString.optional(),
    delta_minutes: z.number().int().optional(),
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
  ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
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
  ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
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
 * Server queries overdue P0/P1 tasks for the user.
 */
export const bulkSnoozeOverdueSchema = z.object({
  delta_minutes: z.number().int().positive('delta_minutes must be positive'),
})

export type BulkSnoozeOverdueInput = z.infer<typeof bulkSnoozeOverdueSchema>

export function validateBulkSnoozeOverdue(input: unknown): BulkSnoozeOverdueInput {
  return bulkSnoozeOverdueSchema.parse(input)
}
