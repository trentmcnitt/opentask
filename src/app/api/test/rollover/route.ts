/**
 * Test-only rollover trigger
 *
 * POST /api/test/rollover { user_id?: number, now?: string } - run the task
 * queue's rollover (src/core/tasks/task-rollover.ts) now, or as of `now` (an
 * ISO instant), for one user or all. It is the same job the minute crons run,
 * exactly once per user per OpenTask day: a user seen for the first time (a
 * NULL `last_rollover_date`, as after a reset) is only stamped, so a test
 * runs it once to stamp and again with a later `now` to roll. Strips only
 * with the switch on (`POST /api/test/task-queue`).
 *
 * Gated by OPENTASK_TEST_MODE=1, like /api/test/reset: a 404 otherwise.
 */

import { NextRequest } from 'next/server'
import { notFound, success, badRequest } from '@/lib/api-response'
import { runTaskRollover } from '@/core/tasks/task-rollover'

export async function POST(request: NextRequest) {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return notFound('Not found')
  }
  const body = (await request.json().catch(() => ({}))) as {
    user_id?: unknown
    now?: unknown
  } | null
  const userId = body?.user_id
  if (userId !== undefined && !(typeof userId === 'number' && Number.isInteger(userId))) {
    return badRequest('user_id must be an integer')
  }
  let now: Date | undefined
  if (body?.now !== undefined) {
    now = typeof body.now === 'string' ? new Date(body.now) : new Date(NaN)
    if (Number.isNaN(now.getTime())) return badRequest('now must be an ISO instant')
  }
  return success(runTaskRollover({ now, userId: userId as number | undefined }))
}
