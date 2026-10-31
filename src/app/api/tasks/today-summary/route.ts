/**
 * Today's summary API (2026-10-30, Today's all-clear card)
 *
 * GET /api/tasks/today-summary - { done, moved }: of the tasks that were in
 * Late or Today during this OpenTask day, how many were done and how many
 * moved to tomorrow (`src/core/tasks/today-summary.ts`).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError } from '@/lib/api-response'
import { todaySummary } from '@/core/tasks/today-summary'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    return success(todaySummary(user.id, user.timezone, dayBoundaryForUser(user.id)))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/tasks/today-summary error:', err)
    return handleError(err)
  }
})
