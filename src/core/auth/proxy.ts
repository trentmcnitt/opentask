/**
 * Reverse proxy header authentication
 *
 * When OpenTask runs behind a reverse proxy (e.g., Authelia, Authentik, Caddy
 * forward_auth), the proxy can pass the authenticated username in a header.
 * This module checks that header and looks up the corresponding user.
 *
 * Opt-in via OPENTASK_PROXY_AUTH_HEADER env var (e.g., "X-Forwarded-User").
 *
 * SECURITY: The reverse proxy MUST strip this header from external requests.
 * If external clients can set this header, they can authenticate as any user.
 */

import { NextRequest } from 'next/server'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { toAuthUser } from './helpers'
import type { AuthUser } from '@/types'

/**
 * Check whether reverse proxy auth is enabled via env var.
 */
export function isProxyAuthEnabled(): boolean {
  return !!process.env.OPENTASK_PROXY_AUTH_HEADER
}

/**
 * Authenticate a request via reverse proxy header.
 *
 * Returns the matching user if the configured header is present and the
 * username resolves to an existing user. Returns null otherwise.
 */
export function getProxyAuthUser(request: NextRequest): AuthUser | null {
  const headerName = process.env.OPENTASK_PROXY_AUTH_HEADER
  if (!headerName) {
    return null
  }

  const username = request.headers.get(headerName)
  if (!username) {
    return null
  }

  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT id, email, name, timezone, default_grouping, is_demo
    FROM users
    WHERE LOWER(name) = LOWER(?)
  `,
    )
    .get(username) as
    | {
        id: number
        email: string
        name: string
        timezone: string
        default_grouping: string
        is_demo: number
      }
    | undefined

  if (!row) {
    log.warn('auth', `Proxy auth: user not found for header value "${username}"`)
    return null
  }

  return toAuthUser(row)
}
