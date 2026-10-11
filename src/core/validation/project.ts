/**
 * Zod validation schemas for project operations
 */

import { z } from 'zod'
import { PROJECT_DESCRIPTION_MAX } from '@/lib/project-description'

// The cap's reasoning is with it, in src/lib/project-description.ts.
export { PROJECT_DESCRIPTION_MAX }

/**
 * Trimmed, and the cap applies after trimming. `null` or an empty string
 * clears it — `src/core/projects` stores either as NULL.
 */
const description = z
  .string()
  .trim()
  .max(PROJECT_DESCRIPTION_MAX, `Description must be at most ${PROJECT_DESCRIPTION_MAX} characters`)
  .nullable()
  .optional()

const colorEnum = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'])

export const projectCreateSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(200, 'Project name too long'),
  shared: z.boolean().default(false),
  // Absent means "at the end" — resolved by the route, which knows the max.
  sort_order: z.number().int().optional(),
  color: colorEnum.nullable().optional(),
  description,
})

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>

export const projectUpdateSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(200, 'Project name too long').optional(),
  shared: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  color: colorEnum.nullable().optional(),
  description,
})

export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>

export function validateProjectCreate(input: unknown): ProjectCreateInput {
  return projectCreateSchema.parse(input)
}

export function validateProjectUpdate(input: unknown): ProjectUpdateInput {
  return projectUpdateSchema.parse(input)
}
