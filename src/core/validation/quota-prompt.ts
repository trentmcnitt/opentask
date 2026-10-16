/**
 * Quota reminders (2026-09-24): request bodies for acting on prompts.
 *
 * A prompt is addressed by its `prompt_key` ("q:<taskId>:<k>:<date>"); the
 * key's own format and freshness are checked in `planPromptActions`, where the
 * user's timezone is known. Here only the shape is.
 */
import { z } from 'zod'
import { CLIENT_PROGRESS_SOURCES } from '@/lib/progress-source'

const promptKey = z.string().min(1).max(64)

/**
 * Where a did-it or a put-back was made from (`progress_events.source`,
 * 2026-10-16). Optional, so a client that predates it keeps working: it is
 * recorded as `api`. `undo`/`redo` are the server's own and refused here.
 */
export const progressSource = z.enum(CLIENT_PROGRESS_SOURCES).optional()

/** POST /api/quota-prompts/consider, /did and /restore. */
export const promptKeysSchema = z.object({
  keys: z.array(promptKey).min(1, 'At least one prompt key required').max(500),
  source: progressSource,
})

export type PromptKeysInput = z.infer<typeof promptKeysSchema>

/**
 * One prompt in a mixed commit. `did: true` is the square checkbox (progress +
 * considered); omitted or false is the circle (considered only). A bare
 * string is shorthand for considering it — "Complete all" only ever considers.
 */
const promptEntry = z
  .union([promptKey, z.object({ key: promptKey, did: z.boolean().optional() }).strict()])
  .transform((entry) =>
    typeof entry === 'string' ? { key: entry, did: false } : { key: entry.key, did: !!entry.did },
  )

/**
 * POST /api/tasks/bulk/complete — reminder/task ids and prompt actions in ONE
 * transaction and ONE undo entry (the notification checklist, a slot's
 * "Considered all"). `ids` may be empty when `prompts` is not. Bare quota ids
 * are still skipped/refused exactly as before; a quota is acted on through
 * its prompt, never completed by id.
 */
export const bulkCompleteSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(500, 'Too many task IDs (max 500)').default([]),
    close_period: z.boolean().optional(),
    prompts: z.array(promptEntry).max(500, 'Too many prompts (max 500)').default([]),
    source: progressSource,
  })
  .refine((body) => body.ids.length > 0 || body.prompts.length > 0, {
    message: 'At least one task ID or prompt required',
    path: ['ids'],
  })

export type BulkCompleteInput = z.infer<typeof bulkCompleteSchema>

export function validatePromptKeys(input: unknown): PromptKeysInput {
  return promptKeysSchema.parse(input)
}

export function validateBulkComplete(input: unknown): BulkCompleteInput {
  return bulkCompleteSchema.parse(input)
}
