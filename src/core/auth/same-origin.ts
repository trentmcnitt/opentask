/**
 * SAME-ORIGIN CHECK for a cookie-authenticated POST (2026-10-26; first used by
 * POST /api/notifications/actions, whose cookie path is the service worker's
 * "Considered" button; since Push PR 4 also POST /api/quota-prompts/consider
 * and /did, the named quota-prompt push's "Considered" and "Did it").
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
 * A request with neither is refused.
 *
 * PROXY-HEADER LOGINS ARE CHECKED TOO (review of #377). A proxy-header user
 * (Authelia, Authentik, Caddy forward_auth) is logged in by the PROXY's own
 * session cookie — as ambient as ours: a third-party page's cross-site POST
 * carries it, and the proxy then adds the user header. So a request
 * authenticated by the proxy header must say it is same-origin as well. Only
 * a Bearer or body token is exempt: no page can make a browser send one (the
 * native apps, which send no Origin, use tokens).
 */

import type { NextRequest } from 'next/server'
import { getRequestContext } from '@/core/request-context'

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

/**
 * Whether an AUTHENTICATED request must be refused as cross-site: it was
 * authenticated by an ambient credential — the session cookie, or the proxy
 * header (behind the proxy's own cookie) — not a Bearer or body token (the
 * request context's `authMethod`, set by the auth step), and it does not say
 * it is same-origin. Call it after authenticating.
 */
export function isCrossSiteCookieRequest(request: NextRequest): boolean {
  return getRequestContext()?.authMethod !== 'token' && !isSameOriginRequest(request)
}
