/**
 * Zod validation schemas for webhook operations
 */

import { z } from 'zod'

const webhookEvents = z.enum([
  'task.created',
  'task.updated',
  'task.completed',
  'task.deleted',
  'task.snoozed',
  // §7.5: skipping is NOT completing. Anything downstream that counts
  // completions must not see a skip.
  'task.skipped',
  // §5: a tracked task reaching its target. Distinct from task.completed,
  // which fires only at the period boundary.
  'task.progressed',
])

export const webhookCreateSchema = z.object({
  url: z.string().url(),
  events: z.array(webhookEvents).min(1),
})

export const webhookUpdateSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(webhookEvents).min(1).optional(),
  active: z.boolean().optional(),
})

export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>
export type WebhookUpdateInput = z.infer<typeof webhookUpdateSchema>

export function validateWebhookCreate(data: unknown): WebhookCreateInput {
  return webhookCreateSchema.parse(data)
}

export function validateWebhookUpdate(data: unknown): WebhookUpdateInput {
  return webhookUpdateSchema.parse(data)
}
