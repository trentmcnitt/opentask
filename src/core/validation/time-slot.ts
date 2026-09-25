/**
 * Time slot validation (REDESIGN-V03 §6.0)
 */

import { z } from 'zod'

/**
 * HH:MM, 24-hour, local. Validated at the boundary so a malformed value can't
 * reach the assignment algorithm and sort to an arbitrary position.
 */
const startTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'start_time must be HH:MM (24-hour)')

export const timeSlotCreateSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(100, 'Label too long'),
  start_time: startTime,
  sort_order: z.number().int().min(0).max(1000).default(0),
})

export type TimeSlotCreateInput = z.infer<typeof timeSlotCreateSchema>

export function validateTimeSlotCreate(input: unknown): TimeSlotCreateInput {
  return timeSlotCreateSchema.parse(input)
}

/**
 * PATCH /api/time-slots/{id}: rename, move, or both. No `sort_order` — every
 * reader orders slots by `start_time` (see `src/core/time-slots/index.ts`),
 * so the order follows the time and there is nothing separate to reorder.
 */
export const timeSlotUpdateSchema = z
  .object({
    label: z.string().trim().min(1, 'Label is required').max(100, 'Label too long').optional(),
    start_time: startTime.optional(),
  })
  .strict()
  .refine((data) => data.label !== undefined || data.start_time !== undefined, {
    message: 'Provide label and/or start_time',
  })

export type TimeSlotUpdateInput = z.infer<typeof timeSlotUpdateSchema>

export function validateTimeSlotUpdate(input: unknown): TimeSlotUpdateInput {
  return timeSlotUpdateSchema.parse(input)
}
