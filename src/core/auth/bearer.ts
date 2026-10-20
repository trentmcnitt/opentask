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
import { recordAuth } from '@/core/request-context'

/**
 * `api_tokens.last_used_at` is written at most once a minute per token, so a
 * client polling GETs doesn't turn every read into a write.
 */
export const LAST_USED_THROTTLE_MS = 60_000

function touchLastUsed(tokenId: number): void {
  const now = Date.now()
  getDb()
    .prepare(
      `UPDATE api_tokens SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .run(new Date(now).toISOString(), tokenId, new Date(now - LAST_USED_THROTTLE_MS).toISOString())
}

/**
 * Validate a Bearer token and return the associated user
 *
 * Hashes the incoming token with SHA-256 before looking it up,
 * since only hashes are stored in the database.
 *
 * A valid token is also recorded in the request context (its id, name and
 * source — client attribution, `src/core/request-context.ts`) and stamps
 * `last_used_at` (throttled, `LAST_USED_THROTTLE_MS`).
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
    SELECT u.id, u.email, u.name, u.timezone, u.default_grouping, u.is_demo,
           t.id AS token_id, t.name AS token_name, t.source AS token_source
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token = ?
  `,
    )
    .get(hashed) as
    | {
        id: number
        email: string
        name: string
        timezone: string
        default_grouping: string
        is_demo: number
        token_id: number
        token_name: string
        token_source: string
      }
    | undefined

  if (!row) {
    log.warn('auth', `Bearer token rejected: not found (ends ...${token.slice(-8)})`)
    return null
  }

  recordAuth('token', { id: row.token_id, name: row.token_name, source: row.token_source })
  touchLastUsed(row.token_id)
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
