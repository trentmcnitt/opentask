/**
 * Test-only DB reset endpoint
 *
 * POST /api/test/reset - Reset database to deterministic test state
 *
 * Gated by OPENTASK_TEST_MODE=1 environment variable.
 * Returns 404 if not in test mode (invisible in production).
 */

import { resetDb } from '@/core/db'
import { seedTestData } from '../../../../../scripts/seed-test'
import { notFound, internalError, success } from '@/lib/api-response'
import { log } from '@/lib/logger'

export async function POST() {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return notFound('Not found')
  }

  try {
    resetDb()
    await seedTestData()
    return success({ ok: true })
  } catch (err) {
    log.error('api', 'Test reset failed:', err)
    return internalError(String(err))
  }
}
