/**
 * Shared helpers for auth user mapping
 */

import type { AuthUser } from '@/types'
import { coerceGrouping } from '@/lib/grouping'

interface UserRow {
  id: number
  email: string
  name: string
  timezone: string
  default_grouping: string
  is_demo: number | boolean
}

/**
 * Convert a database user row to an AuthUser, coercing default_grouping to its
 * union type with the dashboard's own rule (`coerceGrouping`,
 * `src/lib/grouping.ts`): the retired 'time' becomes 'project' (All), and any
 * other value the union no longer covers — 'reminders', from when the §6
 * surface persisted as a dashboard view, and 'recent', the short-lived "Recent"
 * view — becomes 'slot'. This value is only echoed back to callers, never used
 * to choose a view (see the type), so the coercion is about keeping the union
 * honest and agreeing with what the dashboard shows.
 */
export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    default_grouping: coerceGrouping(row.default_grouping),
    is_demo: row.is_demo === 1 || row.is_demo === true,
  }
}
