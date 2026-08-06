/**
 * POST /api/tokens/provision
 *
 * Auto-provisioning of the iOS Bearer token. The interesting case is the cross-user hole:
 * when the webview signs in as a different user than the one whose token sits in the
 * keychain, the server must NOT report "active" (which left native holding the previous
 * account's token — widgets showed the wrong user's tasks). `local_token_preview` is what
 * makes that detectable.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import {
  baseUrl,
  apiFetch,
  apiFetchB,
  resetTestData,
  sessionCookieFromToken,
  TOKEN_A,
  TOKEN_B,
} from './helpers'

interface ProvisionBody {
  has_local_token: boolean
  local_token_preview?: string
}

function provision(cookie: string, body: ProvisionBody): Promise<Response> {
  return fetch(`${baseUrl()}/api/tokens/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  })
}

async function iosTokenPreviews(fetcher: typeof apiFetch): Promise<string[]> {
  const res = await fetcher('/api/tokens')
  const data = await res.json()
  return data.data.tokens
    .filter((t: { name: string }) => t.name === 'iOS App')
    .map((t: { token_preview: string }) => t.token_preview)
}

describe('POST /api/tokens/provision', () => {
  let cookieA = ''
  let cookieB = ''
  let previewA = ''
  let previewB = ''

  beforeAll(async () => {
    await resetTestData()
    cookieA = await sessionCookieFromToken(TOKEN_A)
    cookieB = await sessionCookieFromToken(TOKEN_B)
  })

  test('provisions a token when native has none', async () => {
    const res = await provision(cookieA, { has_local_token: false })
    expect(res.status).toBe(201)

    const body = await res.json()
    expect(body.data.status).toBe('provisioned')
    expect(typeof body.data.token).toBe('string')

    previewA = body.data.token.slice(-8)
    expect(await iosTokenPreviews(apiFetch)).toEqual([previewA])
  })

  test('matching preview short-circuits to active', async () => {
    const res = await provision(cookieA, { has_local_token: true, local_token_preview: previewA })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.data.status).toBe('active')
    expect(body.data.token).toBeUndefined()
  })

  test('omitted preview keeps the legacy assume-it-matches behavior', async () => {
    // Older iOS builds do not inject __OPENTASK_TOKEN_PREVIEW
    const res = await provision(cookieA, { has_local_token: true })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.data.status).toBe('active')
    expect(body.data.token).toBeUndefined()
  })

  test('sets up an iOS token for user B', async () => {
    const res = await provision(cookieB, { has_local_token: false })
    expect(res.status).toBe(201)

    const body = await res.json()
    previewB = body.data.token.slice(-8)
    expect(await iosTokenPreviews(apiFetchB)).toEqual([previewB])
  })

  test("another user's token preview mints a replacement instead of reporting active", async () => {
    const res = await provision(cookieB, { has_local_token: true, local_token_preview: previewA })
    expect(res.status).toBe(201)

    const body = await res.json()
    expect(body.data.status).toBe('provisioned')
    expect(typeof body.data.token).toBe('string')

    const newPreview = body.data.token.slice(-8)
    expect(newPreview).not.toBe(previewA)
    expect(newPreview).not.toBe(previewB)

    // B's pre-existing iOS token is left alone — other devices may still be using it
    const previews = await iosTokenPreviews(apiFetchB)
    expect(previews).toContain(previewB)
    expect(previews).toContain(newPreview)
    expect(previews).toHaveLength(2)

    // The replacement authenticates as B, not as A
    const tasksRes = await fetch(`${baseUrl()}/api/tasks`, {
      headers: { Authorization: `Bearer ${body.data.token}` },
    })
    expect(tasksRes.status).toBe(200)
    const tasks = await tasksRes.json()
    const titles = tasks.data.tasks.map((t: { title: string }) => t.title)
    expect(titles).toContain('User B task')
    expect(titles).not.toContain('Buy groceries')

    // User A's token was not touched by B's provisioning
    expect(await iosTokenPreviews(apiFetch)).toEqual([previewA])
  })

  test('rejects Bearer token auth', async () => {
    const res = await fetch(`${baseUrl()}/api/tokens/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ has_local_token: false }),
    })
    expect(res.status).toBe(403)
  })

  test('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl()}/api/tokens/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ has_local_token: false }),
    })
    expect(res.status).toBe(401)
  })
})
