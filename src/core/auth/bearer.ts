/**
 * Bearer token authentication for API access
 *
 * CLI and programmatic access uses Bearer tokens stored in the api_tokens table.
 */

import { getDb } from '@/core/db'
import type { AuthUser } from '@/types'

/**
 * Validate a Bearer token and return the associated user
 *
 * @param token The Bearer token (without "Bearer " prefix)
 * @returns The authenticated user or null if invalid
 */
export function validateBearerToken(token: string): AuthUser | null {
  if (!token || token.length < 32) {
    return null
  }

  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT u.id, u.email, u.name, u.timezone, u.default_grouping
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token = ?
  `,
    )
    .get(token) as
    | { id: number; email: string; name: string; timezone: string; default_grouping: string }
    | undefined

  if (!row) {
    return null
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    default_grouping: (row.default_grouping === 'time' ? 'time' : 'project') as 'time' | 'project',
  }
}

/**
 * Extract Bearer token from Authorization header
 *
 * @param authHeader The full Authorization header value
 * @returns The token or null if not a Bearer token
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null
  }

  if (!authHeader.startsWith('Bearer ')) {
    return null
  }

  return authHeader.slice(7)
}
