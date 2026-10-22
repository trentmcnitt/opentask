/**
 * Test-only shelved-AI-features switch
 *
 * POST /api/test/ai-unshelve { enabled: boolean } - turn OPENTASK_AI_UNSHELVE
 * on or off in this server process, so an integration test can reach What's
 * Next, Insights and Quick Take against a server that otherwise runs with them
 * shelved (the default every other test expects, as production does). The
 * switch is read at call time (`shelvedAiFeaturesOn`), so the change applies
 * to the next request. A test that turns it on must turn it off again.
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
  if (body.enabled) process.env.OPENTASK_AI_UNSHELVE = '1'
  else delete process.env.OPENTASK_AI_UNSHELVE
  return success({ enabled: body.enabled })
}
