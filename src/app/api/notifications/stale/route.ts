/**
 * The banner reconcile (2026-11-10)
 *
 * POST /api/notifications/stale  { banners: [{ id, task_id?, prompt_key?, icon?, kind?, slot_id? }] }
 *   → { data: { stale: [id, …] } }
 *
 * The native apps send what each of their delivered banners carries; the
 * answer is the identifiers that no longer stand, which the app removes. Asked
 * after every `dismiss` silent push and when the app goes to the background,
 * so one push that gets through iOS's silent-push budget cleans every stale
 * banner, not only its own task's. The rules: `src/core/notifications/stale.ts`.
 * Read-only.
 */
import { NextRequest } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { staleBannerIds } from '@/core/notifications/stale'
import { validateStaleBanners } from '@/core/validation'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { banners } = validateStaleBanners(await request.json())
    const stale = staleBannerIds(user.id, banners)
    if (stale.length > 0) {
      log.info(
        'notifications',
        `Reconcile for user ${user.id}: ${stale.length} of ${banners.length} banner(s) stale`,
      )
    }
    return success({ stale })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/notifications/stale error:', err)
    return handleError(err)
  }
})
