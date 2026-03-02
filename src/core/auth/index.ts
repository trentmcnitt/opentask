/**
 * Unified authentication module for OpenTask
 *
 * Provides dual-auth: Bearer token (CLI/API) OR session cookie (Web UI)
 */

import { NextRequest } from 'next/server'
import { auth } from '@/app/api/auth/[...nextauth]/auth'
import { extractBearerToken, validateBearerToken } from './bearer'
import { getProxyAuthUser } from './proxy'
import { toAuthUser } from './helpers'
import type { AuthUser } from '@/types'

export { validateBearerToken, extractBearerToken } from './bearer'
export { validateCredentials, getUserById } from './session'
export { toAuthUser } from './helpers'
export { isProxyAuthEnabled } from './proxy'

/**
 * Get the authenticated user from a request
 *
 * Checks Bearer token first (for CLI/API access), then falls back to
 * session cookie (for web UI).
 *
 * @param request The Next.js request object
 * @returns The authenticated user or null if not authenticated
 */
export async function getAuthUser(request: NextRequest): Promise<AuthUser | null> {
  // First, check for Bearer token
  const authHeader = request.headers.get('Authorization')
  const bearerToken = extractBearerToken(authHeader)

  if (bearerToken) {
    const user = validateBearerToken(bearerToken)
    if (user) {
      return user
    }
    // Invalid Bearer token - don't fall through to session
    // This prevents confusion when a token is provided but invalid
    return null
  }

  // Check for reverse proxy header auth
  const proxyUser = getProxyAuthUser(request)
  if (proxyUser) {
    return proxyUser
  }

  // No Bearer token, check for session
  const session = await auth()

  if (session?.user) {
    // NextAuth session user - extract our custom fields
    // Cast through unknown to handle NextAuth's User type not having our custom fields
    const user = session.user as unknown as AuthUser & { id?: string | number }
    if (user.id) {
      return toAuthUser({
        id: typeof user.id === 'string' ? parseInt(user.id, 10) : user.id,
        email: user.email || '',
        name: user.name || '',
        timezone: user.timezone || 'America/Chicago',
        default_grouping: user.default_grouping || 'project',
        is_demo: user.is_demo ? 1 : 0,
      })
    }
  }

  return null
}

/**
 * Require authentication - throws if not authenticated
 *
 * Use this in API routes to ensure the user is authenticated.
 */
export async function requireAuth(request: NextRequest): Promise<AuthUser> {
  const user = await getAuthUser(request)

  if (!user) {
    throw new AuthError('Authentication required', 'UNAUTHORIZED')
  }

  return user
}

/**
 * Authentication error class
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'UNAUTHORIZED' | 'FORBIDDEN',
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
