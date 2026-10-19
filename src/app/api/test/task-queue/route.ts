/**
 * Test-only task-queue switch
 *
 * POST /api/test/task-queue { enabled: boolean } - turn OPENTASK_TASK_QUEUE on
 * or off in this server process, so an integration test can exercise the
 * picks-and-defers rules against a server that otherwise runs with the switch
 * off (the default every other test expects). The switch is read at call time
 * (`taskQueueEnabled`), so the change applies to the next request. A test that
 * turns it on must turn it off again when it is done.
 *
 * Gated by OPENTASK_TEST_MODE=1, like /api/test/reset: a 404 otherwise.
 */

import { NextRequest } from 'next/server'
import { notFound, success, badRequest } from '@/lib/api-response'

export async function POST(request: NextRequest) {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return notFound('Not found')
  }
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') return badRequest('enabled must be a boolean')
  if (body.enabled) process.env.OPENTASK_TASK_QUEUE = '1'
  else delete process.env.OPENTASK_TASK_QUEUE
  return success({ enabled: body.enabled })
}
