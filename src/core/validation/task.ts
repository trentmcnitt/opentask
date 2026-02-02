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
  title: z.string().min(1, 'Title is required').max(500, 'Title too long'),
  due_at: dateTimeString.nullable().optional(),
  rrule: rruleString,
  recurrence_mode: recurrenceMode.default('from_due').optional(),
  project_id: z.number().int().positive().optional(),
  priority: priority.default(0).optional(),
  labels: labels.default([]).optional(),
})

export type TaskCreateInput = z.infer<typeof taskCreateSchema>

/**
 * Task update (PATCH) input schema
 * All fields optional - only included fields are updated
 */
export const taskUpdateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title too long').optional(),
  due_at: dateTimeString.nullable().optional(),
  rrule: rruleString,
  recurrence_mode: recurrenceMode.optional(),
  project_id: z.number().int().positive().optional(),
  priority: priority.optional(),
  labels: labels.optional(),
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
 */
export const bulkSnoozeSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
  until: dateTimeString,
})

export type BulkSnoozeInput = z.infer<typeof bulkSnoozeSchema>

/**
 * Bulk edit input schema
 */
export const bulkEditSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'At least one task ID required'),
  changes: taskUpdateSchema,
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
