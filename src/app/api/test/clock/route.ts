/**
 * Test-only server clock
 *
 * POST /api/test/clock { now: string | null } - pin this server process's
 * clock to `now` (an ISO instant; it runs on from there at the real rate), or
 * put the real clock back with `null`. Offset-based, process-wide; its known
 * gaps (SQL `'now'` defaults, cron jobs computing on the shifted clock) are in
 * src/core/test-clock.ts. A test that pins it must reset it when it is done
 * (the E2E global teardown resets it too).
 *
 * Gated by OPENTASK_TEST_MODE=1, like /api/test/reset: a 404 otherwise, so
 * outside test mode the route does not exist.
 */

import { NextRequest } from 'next/server'
import { notFound, success, badRequest } from '@/lib/api-response'
import { setTestClock, testClockOffsetMs } from '@/core/test-clock'

export async function POST(request: NextRequest) {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return notFound('Not found')
  }
  const body = (await request.json().catch(() => null)) as { now?: unknown } | null
  if (body === null || !('now' in body)) return badRequest('now must be an ISO instant or null')
  if (body.now === null) {
    setTestClock(null)
  } else {
    const instant = typeof body.now === 'string' ? new Date(body.now) : new Date(NaN)
    if (Number.isNaN(instant.getTime())) return badRequest('now must be an ISO instant or null')
    setTestClock(instant)
  }
  return success({ now: new Date().toISOString(), offset_ms: testClockOffsetMs() })
}
