/**
 * Integration tests for AI context preferences
 *
 * Tests the ai_context field on the /api/user/preferences endpoint.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

beforeAll(async () => {
  await resetTestData()
})

describe('AI context preferences', () => {
  test('GET returns ai_context as null by default', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBeNull()
  })

  test('PATCH sets ai_context', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: 'I work from home as a software engineer' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBe('I work from home as a software engineer')
  })

  test('GET returns the set ai_context', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBe('I work from home as a software engineer')
  })

  test('PATCH with null clears ai_context', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: null },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBeNull()
  })

  test('PATCH trims whitespace', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: '  I have two kids  ' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBe('I have two kids')
  })

  test('PATCH with empty string clears ai_context', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: '   ' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBeNull()
  })

  test('PATCH with >1000 chars returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: 'x'.repeat(1001) },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('1000')
  })

  test('PATCH with non-string returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: 123 },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('string')
  })

  test('PATCH with exactly 1000 chars succeeds', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: 'a'.repeat(1000) },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_context).toBe('a'.repeat(1000))

    // Clean up
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_context: null },
    })
  })
})
