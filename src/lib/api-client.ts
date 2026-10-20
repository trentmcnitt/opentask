/**
 * Small client-side fetch helpers for routes that answer in the standard
 * envelope (`{ data }` on success, `{ error, code }` on failure — see
 * `src/lib/api-response.ts`).
 */

import { CLIENT_HEADER } from '@/lib/client-attribution'

/**
 * fetch + unwrap `{ data }`, throwing the server's own message on failure.
 *
 * Names the web app in `X-OpenTask-Client` (client attribution). Most of the
 * web app still calls `fetch` directly; those requests carry the session
 * cookie, which the server reads as `web` anyway (`inferClient`).
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set(CLIENT_HEADER, 'web')
  const res = await fetch(url, { ...init, headers })
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null
  if (!res.ok) throw new Error(body?.error || 'Something went wrong')
  return body?.data as T
}

/** A `RequestInit` that sends `body` as JSON with the given method. */
export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
