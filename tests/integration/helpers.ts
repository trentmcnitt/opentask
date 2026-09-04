/**
 * Integration test helpers
 *
 * Provides authenticated fetch wrappers and utility functions.
 */

import fs from 'fs'
import path from 'path'

const ENV_FILE = path.join(process.cwd(), 'data', '.test-integration-env.json')

// Deterministic tokens matching seed-test.ts
export const TOKEN_A = 'a'.repeat(64)
export const TOKEN_B = 'b'.repeat(64)

function getPort(): number {
  const data = JSON.parse(fs.readFileSync(ENV_FILE, 'utf-8'))
  return data.port
}

export function baseUrl(): string {
  return `http://localhost:${getPort()}`
}

interface FetchOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

function buildInit(token: string | null, opts: FetchOptions = {}): RequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }
}

/** Fetch as User A (authenticated) */
export function apiFetch(path: string, opts: FetchOptions = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, buildInit(TOKEN_A, opts))
}

/** Fetch as User B (authenticated) */
export function apiFetchB(path: string, opts: FetchOptions = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, buildInit(TOKEN_B, opts))
}

/** Fetch with no auth */
export function apiAnon(path: string, opts: FetchOptions = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, buildInit(null, opts))
}

/** All `name=value` pairs from a response's Set-Cookie headers */
export function setCookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(';')[0])
}

/**
 * Mint a NextAuth session cookie from a Bearer token.
 * Returns a `Cookie:` header value usable for session-authenticated requests.
 */
export async function sessionCookieFromToken(token: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/api/auth/session-from-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`session-from-token failed: ${res.status} ${await res.text()}`)
  }
  const pairs = setCookiePairs(res)
  if (pairs.length === 0) {
    throw new Error('session-from-token returned no Set-Cookie header')
  }
  return pairs.join('; ')
}

/** Reset test data to deterministic state */
export async function resetTestData(): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/test/reset`, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`Reset failed: ${res.status}`)
  }
}
