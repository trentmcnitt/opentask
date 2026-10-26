/**
 * SAME-ORIGIN CHECK for a cookie-authenticated POST (2026-10-26; first used by
 * POST /api/notifications/actions, whose cookie path is the service worker's
 * "Considered" button).
 *
 * The session cookie is SameSite=Lax (NextAuth's default — `auth.ts` sets no
 * cookie options — and the cookie `session-from-token` mints), so a browser
 * does not send it on a cross-site POST. This is the second wall: a request
 * authenticated by the cookie alone must also SAY it is same-origin —
 *  - `Sec-Fetch-Site: same-origin` (every current browser sends it, a service
 *    worker's same-origin fetch included), or
 *  - an `Origin` header equal to the app's own origin (a browser sends Origin
 *    on every POST): `AUTH_URL`'s origin, or the one the request arrived on
 *    (`X-Forwarded-Proto` / `X-Forwarded-Host` behind the reverse proxy, else
 *    the URL and `Host`).
 * A request with neither is refused. Token and proxy-header requests never
 * come here: they carry no ambient credential a third-party page could ride
 * (the native apps send no Origin).
 */

import type { NextRequest } from 'next/server'

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The origins this app is served on, as this request sees them. */
function appOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>()
  const configured = originOf(process.env.AUTH_URL ?? process.env.NEXTAUTH_URL)
  if (configured) origins.add(configured)
  const first = (value: string | null) => value?.split(',')[0]?.trim() || null
  const proto = first(request.headers.get('x-forwarded-proto'))
  const host = first(request.headers.get('x-forwarded-host')) ?? request.headers.get('host')
  const protocol = proto ? (proto.endsWith(':') ? proto : `${proto}:`) : request.nextUrl.protocol
  if (host) {
    const arrived = originOf(`${protocol}//${host}`)
    if (arrived) origins.add(arrived)
  }
  origins.add(request.nextUrl.origin)
  return origins
}

/** Whether a browser request says it comes from this app's own origin. */
export function isSameOriginRequest(request: NextRequest): boolean {
  if (request.headers.get('sec-fetch-site') === 'same-origin') return true
  const origin = request.headers.get('origin')
  return origin !== null && appOrigins(request).has(origin)
}
