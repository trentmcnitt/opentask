/**
 * Bearer token → web session bootstrap
 *
 * POST /api/auth/session-from-token
 *
 * The iOS app wraps the PWA in a WKWebView. NextAuth JWT sessions expire after 7 days,
 * but the app holds a permanently-valid Bearer token in the keychain — this endpoint is
 * how it converts that token into a real session cookie so the webview is logged in again
 * without the user retyping a password.
 *
 * Auth is Bearer token ONLY. A missing, malformed, or invalid Authorization header is a
 * hard 401: falling back to session-cookie auth would be circular (the endpoint exists to
 * create the session), and falling back on an *invalid* token would be a security bypass.
 * So this route deliberately does not use `getAuthUser()`/`requireAuth()`.
 *
 * Success sets the NextAuth session cookie via Set-Cookie and returns `{ ok: true }`.
 */

import { NextRequest } from 'next/server'
import { AuthError, extractBearerToken, validateBearerToken } from '@/core/auth'
import {
  SESSION_MAX_AGE_SECONDS,
  getAuthSecret,
  isSecureSessionRequest,
  mintSessionToken,
  sessionCookieName,
} from '@/core/auth/session-cookie'
import { success, unauthorized, internalError, handleError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const token = extractBearerToken(request.headers.get('Authorization'))
    if (!token) {
      return unauthorized('Bearer token required')
    }

    const user = validateBearerToken(token)
    if (!user) {
      return unauthorized('Invalid token')
    }

    const secret = getAuthSecret()
    if (!secret) {
      log.error('auth', 'session-from-token: AUTH_SECRET is not configured')
      return internalError('Session secret not configured')
    }

    const secure = isSecureSessionRequest(request)
    const cookieName = sessionCookieName(request)
    const sessionToken = await mintSessionToken(user, cookieName, secret)

    const response = success({ ok: true })
    response.cookies.set({
      name: cookieName,
      value: sessionToken,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure,
      maxAge: SESSION_MAX_AGE_SECONDS,
    })

    log.info('auth', `Minted web session from Bearer token for user ${user.id}`)
    return response
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/auth/session-from-token error:', err)
    return handleError(err)
  }
})
