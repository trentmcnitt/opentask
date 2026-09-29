/**
 * Small client-side fetch helpers for routes that answer in the standard
 * envelope (`{ data }` on success, `{ error, code }` on failure — see
 * `src/lib/api-response.ts`).
 */

/** fetch + unwrap `{ data }`, throwing the server's own message on failure. */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null
  if (!res.ok) throw new Error(body?.error || 'Something went wrong')
  return body?.data as T
}

/** A `RequestInit` that sends `body` as JSON with the given method. */
export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
