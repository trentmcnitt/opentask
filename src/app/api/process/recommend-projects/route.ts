/**
 * POST /api/process/recommend-projects — the Process button's project step.
 *
 * Body `{ ids: number[] }` (1–100 of the caller's tasks). Returns
 * `{ data: { recommendations: [{ task_id, project_id | null, reason }] } }`.
 * The AI only recommends; nothing is written — the modal highlights the pick
 * and the user chooses (`recommendProjects` in src/core/ai/process.ts).
 *
 * AI off → `{ recommendations: [] }` with 200, never an error: the modal just
 * has no recommendation to show. A failed model call → 503.
 */

import { NextRequest } from 'next/server'
import { ZodError } from 'zod'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { recommendProjects, validateRecommendProjectsInput } from '@/core/ai/process'
import { success, handleError, handleZodError, serviceUnavailable } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids } = validateRecommendProjectsInput(await request.json())

    const result = await recommendProjects(user.id, ids)
    if (result.status === 'failed') {
      return serviceUnavailable('Could not get project recommendations')
    }
    return success({ recommendations: result.status === 'ok' ? result.items : [] })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) {
      log.error('api', 'POST /api/process/recommend-projects error:', err)
    }
    return handleError(err)
  }
})
