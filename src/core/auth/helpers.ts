/**
 * Shared helpers for auth user mapping
 */

import type { AuthUser } from '@/types'

interface UserRow {
  id: number
  email: string
  name: string
  timezone: string
  default_grouping: string
  is_demo: number | boolean
}

/** Every grouping the column is allowed to hold. See `AuthUser.default_grouping`. */
const GROUPINGS: AuthUser['default_grouping'][] = ['time', 'project', 'unified', 'slot']

/**
 * Convert a database user row to an AuthUser, coercing default_grouping to its
 * union type.
 *
 * The column is free-form TEXT, and it has held values this union no longer
 * covers — 'reminders', from when the §6 surface persisted as a dashboard view.
 * Anything unrecognized becomes 'project', the long-standing fallback. This value
 * is only echoed back to callers, never used to choose a view (see the type), so
 * the fallback is about keeping the union honest rather than about what the user
 * sees; the dashboard's own coercion lives in `PreferencesProvider`.
 */
export function toAuthUser(row: UserRow): AuthUser {
  const grouping = row.default_grouping as AuthUser['default_grouping']
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    default_grouping: GROUPINGS.includes(grouping) ? grouping : 'project',
    is_demo: row.is_demo === 1 || row.is_demo === true,
  }
}
