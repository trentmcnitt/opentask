/**
 * NextAuth session cookie minting
 *
 * Used by `POST /api/auth/session-from-token` to turn a Bearer API token into a real
 * NextAuth session cookie (the iOS WKWebView holds a permanently-valid token in the
 * keychain but has no way to log the webview in when the 7-day JWT session expires).
 *
 * Everything here mirrors what @auth/core does internally when it issues a session at
 * sign-in. Three details must match exactly or the minted cookie is silently ignored:
 *
 * 1. **Cookie name** — `defaultCookies()` prefixes the name with `__Secure-` when the
 *    request is HTTPS. NextAuth derives "is HTTPS" from `AUTH_URL`/`NEXTAUTH_URL` when set,
 *    otherwise from the `x-forwarded-proto` header (see `createActionURL` in
 *    @auth/core/lib/utils/env.js — Next.js always populates that header, and production
 *    runs behind Caddy which sets it to `https`).
 * 2. **Salt** — the JWE encryption key is derived from the secret *and* the cookie name,
 *    so `salt` must equal the cookie name the token will be stored under.
 * 3. **Payload** — must carry the same fields the `jwt` callback puts on the token at
 *    sign-in, so `auth()` produces an identical session downstream.
 */

import { encode } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import type { AuthUser } from '@/types'

/** Session lifetime. Must stay in sync with the NextAuth `session.maxAge` config. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60 // 7 days

/**
 * Whether NextAuth would treat this request as a secure context, and therefore use the
 * `__Secure-` cookie prefix. Mirrors `createActionURL()` (env URL first, then
 * `x-forwarded-proto`, defaulting to https) rather than re-deriving it independently.
 */
export function isSecureSessionRequest(request: NextRequest): boolean {
  const envUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL
  if (envUrl) {
    try {
      return new URL(envUrl).protocol === 'https:'
    } catch {
      // Malformed env URL — fall back to header detection, same as NextAuth does
    }
  }

  const detected = request.headers.get('x-forwarded-proto') ?? 'https'
  const protocol = detected.endsWith(':') ? detected : `${detected}:`
  return protocol === 'https:'
}

/** The cookie name NextAuth stores the session JWT under for this request. */
export function sessionCookieName(request: NextRequest): string {
  return isSecureSessionRequest(request) ? '__Secure-authjs.session-token' : 'authjs.session-token'
}

/** The secret NextAuth derives its JWT encryption key from. */
export function getAuthSecret(): string | null {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null
}

/**
 * Encode a session JWT identical to the one a credentials sign-in produces.
 *
 * At sign-in @auth/core builds `{ name, email, picture, sub }` and hands it to the `jwt`
 * callback, which adds `id`, `timezone`, `default_grouping` and `is_demo`. `picture` is
 * `undefined` for credentials logins (dropped during serialization), so it is omitted here.
 * `iat`/`exp`/`jti` are added by `encode()` itself.
 *
 * @param cookieName Doubles as the encryption salt — must be the cookie the token is set on.
 */
export async function mintSessionToken(
  user: AuthUser,
  cookieName: string,
  secret: string,
): Promise<string> {
  return encode({
    salt: cookieName,
    secret,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      name: user.name,
      email: user.email,
      sub: String(user.id),
      id: String(user.id),
      timezone: user.timezone,
      default_grouping: user.default_grouping,
      is_demo: user.is_demo,
    },
  })
}
