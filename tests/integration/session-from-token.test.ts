/**
 * POST /api/auth/session-from-token
 *
 * The iOS app exchanges its long-lived keychain Bearer token for a NextAuth session
 * cookie so the WKWebView is logged in again after the 7-day JWT session expires.
 *
 * The load-bearing assertions here: the minted cookie actually authenticates a
 * cookie-only request as the token's owner, and its name matches the cookie a real
 * credentials login sets in this environment (if the names diverged, `auth()` would
 * silently ignore the minted cookie).
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { baseUrl, apiAnon, resetTestData, setCookiePairs, TOKEN_A, TOKEN_B } from './helpers'

const SEVEN_DAYS = 7 * 24 * 60 * 60

function post(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl()}/api/auth/session-from-token`, { method: 'POST', headers })
}

/** Log in through the NextAuth credentials endpoints the way a browser form does. */
async function realLoginSetCookies(): Promise<string[]> {
  const csrfRes = await fetch(`${baseUrl()}/api/auth/csrf`)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const csrfCookies = setCookiePairs(csrfRes).join('; ')

  const res = await fetch(`${baseUrl()}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrfCookies,
    },
    body: new URLSearchParams({
      csrfToken,
      username: 'Test User A',
      password: 'testpass123',
    }).toString(),
    redirect: 'manual',
  })

  return res.headers.getSetCookie()
}

describe('POST /api/auth/session-from-token', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('valid Bearer token returns 200 with a session cookie', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN_A}` })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.data.ok).toBe(true)

    const cookies = res.headers.getSetCookie()
    expect(cookies.length).toBe(1)

    const cookie = cookies[0]
    expect(cookie).toContain('authjs.session-token=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toContain(`Max-Age=${SEVEN_DAYS}`)
  })

  test('minted cookie authenticates a request with no Bearer token', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN_A}` })
    const cookie = setCookiePairs(res).join('; ')

    // Cookie only — no Authorization header at all
    const tasksRes = await apiAnon('/api/tasks', { headers: { Cookie: cookie } })
    expect(tasksRes.status).toBe(200)

    const data = await tasksRes.json()
    const titles = data.data.tasks.map((t: { title: string }) => t.title)
    expect(titles).toContain('Buy groceries')
    expect(titles).not.toContain('User B task')
  })

  test('minted cookie is scoped to the token owner', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN_B}` })
    const cookie = setCookiePairs(res).join('; ')

    const tasksRes = await apiAnon('/api/tasks', { headers: { Cookie: cookie } })
    expect(tasksRes.status).toBe(200)

    const data = await tasksRes.json()
    const titles = data.data.tasks.map((t: { title: string }) => t.title)
    expect(titles).toContain('User B task')
    expect(titles).not.toContain('Buy groceries')
  })

  test('minted session exposes the same user fields as a real login', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN_A}` })
    const cookie = setCookiePairs(res).join('; ')

    const sessionRes = await fetch(`${baseUrl()}/api/auth/session`, {
      headers: { Cookie: cookie },
    })
    expect(sessionRes.status).toBe(200)

    const session = await sessionRes.json()
    expect(session.user.id).toBe('1')
    expect(session.user.name).toBe('Test User A')
    expect(session.user.email).toBe('test@opentask.local')
    expect(session.user.timezone).toBe('America/Chicago')
    expect(session.user.default_grouping).toBeDefined()
    expect(session.user.is_demo).toBe(false)
  })

  test('minted cookie name matches the cookie a real credentials login sets', async () => {
    const mintedRes = await post({ Authorization: `Bearer ${TOKEN_A}` })
    const mintedName = setCookiePairs(mintedRes)[0].split('=')[0]

    const loginCookies = await realLoginSetCookies()
    const loginSession = loginCookies.find((c) => c.includes('authjs.session-token='))
    expect(loginSession).toBeDefined()

    const loginName = loginSession!.split('=')[0]
    expect(mintedName).toBe(loginName)
  })

  test('uses the __Secure- prefixed name behind an HTTPS proxy', async () => {
    // Production sits behind Caddy, which sets x-forwarded-proto — the same signal NextAuth
    // uses to decide between the prefixed and unprefixed cookie name
    const res = await post({
      Authorization: `Bearer ${TOKEN_A}`,
      'x-forwarded-proto': 'https',
    })
    expect(res.status).toBe(200)

    const cookie = res.headers.getSetCookie()[0]
    expect(cookie.startsWith('__Secure-authjs.session-token=')).toBe(true)
    expect(cookie).toContain('Secure')
  })

  test('invalid Bearer token returns 401 with no cookie', async () => {
    const res = await post({ Authorization: `Bearer ${'z'.repeat(64)}` })
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  test('malformed Authorization header returns 401 with no cookie', async () => {
    const res = await post({ Authorization: TOKEN_A })
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  test('missing Authorization header returns 401 with no cookie', async () => {
    const res = await post()
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  test('an existing session cookie is not accepted in place of a token', async () => {
    // Bootstrapping a session from a session would be circular — cookie auth must not work
    const res = await post({ Authorization: `Bearer ${TOKEN_A}` })
    const cookie = setCookiePairs(res).join('; ')

    const withoutToken = await fetch(`${baseUrl()}/api/auth/session-from-token`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(withoutToken.status).toBe(401)
    expect(withoutToken.headers.getSetCookie()).toHaveLength(0)
  })
})
