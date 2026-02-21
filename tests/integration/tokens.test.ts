/**
 * API Token Management Integration Tests
 *
 * Tests GET/POST /api/tokens and DELETE /api/tokens/:id endpoints,
 * including edge cases: self-revocation, token isolation, uniqueness,
 * preview correctness, whitespace names, double-delete, and boundary lengths.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, baseUrl, resetTestData } from './helpers'

describe('API Token Management', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  // --- GET /api/tokens ---

  test('GET /api/tokens requires auth', async () => {
    const res = await apiAnon('/api/tokens')
    expect(res.status).toBe(401)
  })

  test('GET /api/tokens returns token list for authenticated user', async () => {
    const res = await apiFetch('/api/tokens')
    expect(res.status).toBe(200)
    const json = await res.json()
    const tokens = json.data.tokens
    expect(Array.isArray(tokens)).toBe(true)
    // User A has a seeded token (TOKEN_A)
    expect(tokens.length).toBeGreaterThanOrEqual(1)
  })

  test('GET /api/tokens returns preview not full token', async () => {
    const res = await apiFetch('/api/tokens')
    const json = await res.json()
    const token = json.data.tokens[0]
    expect(token).toHaveProperty('id')
    expect(token).toHaveProperty('name')
    expect(token).toHaveProperty('created_at')
    expect(token).toHaveProperty('token_preview')
    expect(token.token_preview).toHaveLength(8)
    // Must not contain the full token value
    expect(token).not.toHaveProperty('token')
  })

  test('token list is isolated between users', async () => {
    // Create a token as User A with a distinctive name
    await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'User A Secret Token' },
    })

    // User B's list should not contain User A's token
    const listRes = await apiFetchB('/api/tokens')
    const tokensB = (await listRes.json()).data.tokens
    const leaked = tokensB.find((t: { name: string }) => t.name === 'User A Secret Token')
    expect(leaked).toBeUndefined()
  })

  // --- POST /api/tokens ---

  test('POST /api/tokens requires auth', async () => {
    const res = await apiAnon('/api/tokens', {
      method: 'POST',
      body: { name: 'Test Token' },
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/tokens requires non-empty name', async () => {
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: '' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/tokens requires name field', async () => {
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: {},
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/tokens rejects whitespace-only name', async () => {
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: '   ' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/tokens rejects name over 100 characters', async () => {
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'x'.repeat(101) },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/tokens accepts name at exactly 100 characters', async () => {
    const name = 'x'.repeat(100)
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name },
    })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data.name).toBe(name)
  })

  test('POST /api/tokens creates token and returns full value', async () => {
    const res = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Integration Test Token' },
    })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data).toHaveProperty('id')
    expect(json.data.name).toBe('Integration Test Token')
    expect(json.data.token).toHaveLength(64)
    expect(json.data.token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('each created token is unique', async () => {
    const res1 = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Unique Test 1' },
    })
    const res2 = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Unique Test 2' },
    })
    const token1 = (await res1.json()).data.token
    const token2 = (await res2.json()).data.token
    expect(token1).not.toBe(token2)
  })

  test('token preview in list matches last 8 chars of created token', async () => {
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Preview Match Test' },
    })
    const created = (await createRes.json()).data
    const expectedPreview = created.token.slice(-8)

    const listRes = await apiFetch('/api/tokens')
    const tokens = (await listRes.json()).data.tokens
    const found = tokens.find((t: { id: number }) => t.id === created.id)
    expect(found).toBeDefined()
    expect(found.token_preview).toBe(expectedPreview)
  })

  test('created token appears in GET list', async () => {
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'List Verification Token' },
    })
    const created = (await createRes.json()).data

    const listRes = await apiFetch('/api/tokens')
    const tokens = (await listRes.json()).data.tokens
    const found = tokens.find((t: { id: number }) => t.id === created.id)
    expect(found).toBeDefined()
    expect(found.name).toBe('List Verification Token')
  })

  test('created token can be used for authentication', async () => {
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Auth Test Token' },
    })
    const newToken = (await createRes.json()).data.token

    // Use the new token to call an authenticated endpoint
    const res = await fetch(`${baseUrl()}/api/tokens`, {
      headers: {
        Authorization: `Bearer ${newToken}`,
        'Content-Type': 'application/json',
      },
    })
    expect(res.status).toBe(200)
  })

  // --- DELETE /api/tokens/:id ---

  test('DELETE /api/tokens/:id requires auth', async () => {
    const res = await apiAnon('/api/tokens/999', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  test('DELETE /api/tokens/:id returns 404 for non-existent token', async () => {
    const res = await apiFetch('/api/tokens/999999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('DELETE /api/tokens/:id returns 404 for non-numeric id', async () => {
    const res = await apiFetch('/api/tokens/abc', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('DELETE /api/tokens/:id cannot revoke another user token', async () => {
    // Create a token as User A
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Cross-user Test' },
    })
    const tokenId = (await createRes.json()).data.id

    // Try to delete as User B — should look like it doesn't exist
    const deleteRes = await apiFetchB(`/api/tokens/${tokenId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(404)

    // Verify the token still exists for User A
    const listRes = await apiFetch('/api/tokens')
    const tokens = (await listRes.json()).data.tokens
    expect(tokens.find((t: { id: number }) => t.id === tokenId)).toBeDefined()
  })

  test('DELETE /api/tokens/:id revokes own token', async () => {
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Revoke Test Token' },
    })
    const { id: tokenId, token: tokenValue } = (await createRes.json()).data

    // Delete it
    const deleteRes = await apiFetch(`/api/tokens/${tokenId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
    const json = await deleteRes.json()
    expect(json.data.deleted).toBe(true)

    // Verify it's gone from the list
    const listRes = await apiFetch('/api/tokens')
    const tokens = (await listRes.json()).data.tokens
    expect(tokens.find((t: { id: number }) => t.id === tokenId)).toBeUndefined()

    // Verify the revoked token no longer authenticates
    const authRes = await fetch(`${baseUrl()}/api/tokens`, {
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'Content-Type': 'application/json',
      },
    })
    expect(authRes.status).toBe(401)
  })

  test('double-delete returns 404 on second attempt', async () => {
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Double Delete Test' },
    })
    const tokenId = (await createRes.json()).data.id

    // First delete succeeds
    const first = await apiFetch(`/api/tokens/${tokenId}`, { method: 'DELETE' })
    expect(first.status).toBe(200)

    // Second delete returns 404
    const second = await apiFetch(`/api/tokens/${tokenId}`, { method: 'DELETE' })
    expect(second.status).toBe(404)
  })

  test('self-revocation: token can revoke itself', async () => {
    // Create a token
    const createRes = await apiFetch('/api/tokens', {
      method: 'POST',
      body: { name: 'Self Revoke Test' },
    })
    const { id: tokenId, token: tokenValue } = (await createRes.json()).data

    // Use the token to revoke itself
    const deleteRes = await fetch(`${baseUrl()}/api/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'Content-Type': 'application/json',
      },
    })
    // The DELETE response should succeed — auth happens before the delete
    expect(deleteRes.status).toBe(200)

    // But subsequent requests with that token should fail
    const afterRes = await fetch(`${baseUrl()}/api/tokens`, {
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'Content-Type': 'application/json',
      },
    })
    expect(afterRes.status).toBe(401)
  })
})
