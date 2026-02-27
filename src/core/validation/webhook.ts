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
