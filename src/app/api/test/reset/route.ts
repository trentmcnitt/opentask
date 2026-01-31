/**
 * Test-only DB reset endpoint
 *
 * POST /api/test/reset - Reset database to deterministic test state
 *
 * Gated by OPENTASK_TEST_MODE=1 environment variable.
 * Returns 404 if not in test mode (invisible in production).
 */

import { NextResponse } from 'next/server'
import { resetDb } from '@/core/db'
import { seedTestData } from '../../../../../scripts/seed-test'

export async function POST() {
  if (process.env.OPENTASK_TEST_MODE !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    resetDb()
    await seedTestData()
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Test reset failed:', err)
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    )
  }
}
