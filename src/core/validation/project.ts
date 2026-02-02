/**
 * Zod validation schemas for project operations
 */

import { z } from 'zod'

export const projectCreateSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(200, 'Project name too long'),
  shared: z.boolean().default(false),
  sort_order: z.number().int().default(0),
})

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>

export const projectUpdateSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(200, 'Project name too long').optional(),
  shared: z.boolean().optional(),
  sort_order: z.number().int().optional(),
})

export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>

export function validateProjectCreate(input: unknown): ProjectCreateInput {
  return projectCreateSchema.parse(input)
}

export function validateProjectUpdate(input: unknown): ProjectUpdateInput {
  return projectUpdateSchema.parse(input)
}
