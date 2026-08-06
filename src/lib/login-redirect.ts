/**
 * Login redirect helpers — preserve the user's destination across a login bounce.
 *
 * Auth guards (server and client) send unauthenticated users to `/login`. Without a
 * callbackUrl the destination is lost, which matters most in the iOS app: a widget tap
 * opens `/?task=123` and a notification opens `/tasks/123`, and an expired session would
 * otherwise dump the user on a bare dashboard. Guards call `loginUrlFor()` (server) or
 * `loginUrlFromLocation()` (client); the login page reads the value back through
 * `safeCallbackUrl()`, which is the open-redirect guard.
 */

/**
 * Validate a callbackUrl coming from untrusted input (the query string).
 *
 * Only same-origin relative paths are allowed: must start with `/`, must not start with
 * `//` or `/\` (both are parsed as protocol-relative URLs by browsers, which would let an
 * attacker bounce a freshly-authenticated user to another origin). Anything else → `/`.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

/**
 * Build the login URL for a relative in-app destination (path + optional query string).
 *
 * `/` is the login page's own default destination, so it is left off to keep the URL clean.
 */
export function loginUrlFor(destination: string): string {
  const safe = safeCallbackUrl(destination)
  if (safe === '/') return '/login'
  return `/login?callbackUrl=${encodeURIComponent(safe)}`
}

/**
 * Build the login URL for the page the browser is currently on (client components only).
 */
export function loginUrlFromLocation(): string {
  if (typeof window === 'undefined') return '/login'
  return loginUrlFor(window.location.pathname + window.location.search)
}
