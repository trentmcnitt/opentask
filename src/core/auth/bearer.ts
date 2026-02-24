/**
 * Bearer token authentication for API access
 *
 * CLI and programmatic access uses Bearer tokens stored in the api_tokens table.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import type { AuthUser } from '@/types'
import { toAuthUser } from './helpers'
import { hashToken } from './token-hash'

/**
 * Validate a Bearer token and return the associated user
 *
 * Hashes the incoming token with SHA-256 before looking it up,
 * since only hashes are stored in the database.
 *
 * @param token The Bearer token (without "Bearer " prefix)
 * @returns The authenticated user or null if invalid
 */
export function validateBearerToken(token: string): AuthUser | null {
  if (!token || token.length < 32) {
    log.warn('auth', `Bearer token rejected: too short (${token.length} chars)`)
    return null
  }

  const db = getDb()
  const hashed = hashToken(token)

  const row = db
    .prepare(
      `
    SELECT u.id, u.email, u.name, u.timezone, u.default_grouping
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token = ?
  `,
    )
    .get(hashed) as
    | { id: number; email: string; name: string; timezone: string; default_grouping: string }
    | undefined

  if (!row) {
    log.warn('auth', `Bearer token rejected: not found (ends ...${token.slice(-8)})`)
    return null
  }

  return toAuthUser(row)
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
