/**
 * A user's clock for the deadline's implied target (2026-10-10, ruling B2):
 * their timezone and morning time. Server code must pass this explicitly to
 * `effectiveTargetAt` and friends — every user has their own, so the browser's
 * module-level default (`setClientTargetContext`) is never used here.
 *
 * The morning time is the RESOLVED one (`getAnchorTimes`): a Morning linked to
 * a reminder period follows that period's start (2026-10-21). This is the one
 * read behind every rule-time fill, automatic target and deadline-anchored
 * repeat's default lead (`leadTargetFor`), so they all agree.
 */
import { getDb } from '@/core/db'
import { getAnchorTimes } from '@/core/users/anchor-times'
import type { TargetContext } from '@/lib/task-segments'

export function getTargetContext(userId: number): TargetContext {
  const row = getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
    | { timezone: string }
    | undefined
  return { timezone: row?.timezone ?? 'UTC', morningTime: getAnchorTimes(userId).morning.time }
}
