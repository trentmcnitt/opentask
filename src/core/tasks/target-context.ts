/**
 * A user's clock for the deadline's implied target (2026-10-10, ruling B2):
 * their timezone and morning time. Server code must pass this explicitly to
 * `effectiveTargetAt` and friends — every user has their own, so the browser's
 * module-level default (`setClientTargetContext`) is never used here.
 */
import { getDb } from '@/core/db'
import type { TargetContext } from '@/lib/task-segments'

export function getTargetContext(userId: number): TargetContext {
  const row = getDb()
    .prepare('SELECT timezone, morning_time FROM users WHERE id = ?')
    .get(userId) as { timezone: string; morning_time: string | null } | undefined
  return { timezone: row?.timezone ?? 'UTC', morningTime: row?.morning_time || '09:00' }
}
