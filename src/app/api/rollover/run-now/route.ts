/**
 * Roll over now (task queue, 2026-10-20; src/core/tasks/rollover-now.ts)
 *
 * POST /api/rollover/run-now — run the rollover for the CALLER now, as the
 * daily job would at their rollover with now as the moment: past targets
 * below High with no deadline go to the queue, repeating tasks roll or wait.
 * One undo entry. Does not move the daily rollover. `?dry_run=1`: counts and
 * ids only, nothing written. 409 when the server's task queue is off.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError } from '@/lib/api-response'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const flag = request.nextUrl.searchParams.get('dry_run')
    const dryRun = flag === '1' || flag === 'true'
    return success(runRolloverNow({ userId: user.id, dryRun }))
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'POST /api/rollover/run-now error:', err)
    return handleError(err)
  }
})
