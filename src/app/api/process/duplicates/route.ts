/**
 * GET /api/process/duplicates — the Process button's duplicate step.
 *
 * Returns `{ data: { groups: [{ task_ids: number[], reason }] } }`: possible
 * duplicates among the caller's open one-off tasks (not recurring tasks,
 * reminders or quotas). The AI only finds candidates; nothing is written
 * (`findDuplicates` in src/core/ai/process.ts).
 *
 * AI off → `{ groups: [] }` with 200, never an error. A failed model call → 503.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { findDuplicates } from '@/core/ai/process'
import { success, handleError, serviceUnavailable } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    const result = await findDuplicates(user.id)
    if (result.status === 'failed') {
      return serviceUnavailable('Could not check for duplicates')
    }
    return success({ groups: result.status === 'ok' ? result.items : [] })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/process/duplicates error:', err)
    return handleError(err)
  }
})
