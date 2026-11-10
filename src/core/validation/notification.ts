/**
 * The banner reconcile (2026-11-10): the body of POST /api/notifications/stale.
 * One entry per banner the device has delivered — its request identifier and
 * the payload fields the server's rules read (`src/core/notifications/stale.ts`).
 * Unknown fields are dropped, so a newer app can send more without a 400.
 */
import { z } from 'zod'

/**
 * The most banners one request may ask about. Here, not in stale.ts: this
 * module must not import the notification core (stale.ts reaches the task
 * modules, which import this one — a cycle the production build trips on).
 */
export const MAX_RECONCILE_BANNERS = 100

const banner = z.object({
  id: z.string().min(1).max(200),
  task_id: z.number().int().positive().nullish(),
  prompt_key: z.string().max(64).nullish(),
  icon: z.string().max(32).nullish(),
  kind: z.string().max(32).nullish(),
  slot_id: z.number().int().positive().nullish(),
})

export const staleBannersSchema = z.object({
  banners: z.array(banner).max(MAX_RECONCILE_BANNERS),
})

export type StaleBannersInput = z.infer<typeof staleBannersSchema>

export function validateStaleBanners(body: unknown): StaleBannersInput {
  return staleBannersSchema.parse(body)
}
