/**
 * Test-only rollover trigger
 *
 * POST /api/test/rollover { user_id?: number, now?: string, force?: boolean }
 * - run the task queue's rollover (src/core/tasks/task-rollover.ts) now, or
 * as of `now` (an ISO instant), for one user or all. It is the same job the
 * minute crons run, exactly once per user per OpenTask day: a user seen for
 * the first time (a NULL `last_rollover_date`, as after a reset) is only
 * stamped, so a test runs it once to stamp and again with a later `now` to
 * roll. Strips only with the switch on (`POST /api/test/task-queue`).
 *
 * `force` (task-queue PR 3): first set the user's `last_rollover_date` to the
 * OpenTask day before `now`'s, in the same synchronous step as the run, so
 * this call runs the rollover as of `now` even when the minute cron already
 * stamped the day (an E2E user it saw first) — with no window for the cron to
 * run in between. Requires `user_id`. A run as of a PAST `now` leaves the
 * stamp on that past day, so the minute cron (switch on) runs a real
 * rollover for the user within the minute; a test should expect that, or
 * follow with a forced run as of now.
 *
 * Gated by OPENTASK_TEST_MODE=1, like /api/test/reset: a 404 otherwise.
 */

import { NextRequest } from 'next/server'
import { notFound, success, badRequest } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { addDays, openTaskDayOf } from '@/lib/opentask-day'

export async function POST(request: NextRequest) {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return notFound('Not found')
  }
  const body = (await request.json().catch(() => ({}))) as {
    user_id?: unknown
    now?: unknown
    force?: unknown
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
  if (body?.force !== undefined && typeof body.force !== 'boolean') {
    return badRequest('force must be a boolean')
  }
  if (body?.force) {
    if (userId === undefined) return badRequest('force requires user_id')
    const user = getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
      | { timezone: string }
      | undefined
    if (!user) return badRequest('No such user')
    const day = openTaskDayOf(now ?? new Date(), user.timezone, rolloverTimeForUser(userId))
    const before = addDays(day, -1)
    getDb().prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(before, userId)
  }
  return success(runTaskRollover({ now, userId: userId as number | undefined }))
}
