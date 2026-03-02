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

/**
 * Convert a database user row to an AuthUser, coercing default_grouping
 * to the union type ('time' | 'project' | 'unified').
 */
export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    default_grouping:
      row.default_grouping === 'time'
        ? 'time'
        : row.default_grouping === 'unified'
          ? 'unified'
          : 'project',
    is_demo: row.is_demo === 1 || row.is_demo === true,
  }
}
