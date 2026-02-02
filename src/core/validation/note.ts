/**
 * Zod validation schemas for note operations
 */

import { z } from 'zod'

export const noteCreateSchema = z.object({
  content: z.string().min(1, 'Note content is required').max(10000, 'Note content too long'),
})

export type NoteCreateInput = z.infer<typeof noteCreateSchema>

export function validateNoteCreate(input: unknown): NoteCreateInput {
  return noteCreateSchema.parse(input)
}
