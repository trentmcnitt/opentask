/**
 * Reverse proxy header authentication tests
 *
 * Tests getProxyAuthUser() which authenticates requests via a header
 * set by a reverse proxy (e.g., Authelia, Authentik).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getProxyAuthUser, isProxyAuthEnabled } from '@/core/auth/proxy'
import { setupTestDb } from '../helpers/setup'

beforeAll(() => {
  setupTestDb()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  const req = new NextRequest('http://localhost:3000/api/tasks', {
    headers,
  })
  return req
}

describe('isProxyAuthEnabled', () => {
  it('returns false when env var is not set', () => {
    expect(isProxyAuthEnabled()).toBe(false)
  })

  it('returns true when env var is set', () => {
    vi.stubEnv('OPENTASK_PROXY_AUTH_HEADER', 'X-Forwarded-User')
    expect(isProxyAuthEnabled()).toBe(true)
  })
})

describe('getProxyAuthUser', () => {
  it('returns null when env var is not set', () => {
    const request = makeRequest({ 'X-Forwarded-User': 'Test User' })
    expect(getProxyAuthUser(request)).toBeNull()
  })

  it('returns null when header is absent', () => {
    vi.stubEnv('OPENTASK_PROXY_AUTH_HEADER', 'X-Forwarded-User')
    const request = makeRequest()
    expect(getProxyAuthUser(request)).toBeNull()
  })

  it('matches user by name case-insensitively', () => {
    vi.stubEnv('OPENTASK_PROXY_AUTH_HEADER', 'X-Forwarded-User')

    const lower = makeRequest({ 'X-Forwarded-User': 'test user' })
    const upper = makeRequest({ 'X-Forwarded-User': 'TEST USER' })
    const exact = makeRequest({ 'X-Forwarded-User': 'Test User' })

    const resultLower = getProxyAuthUser(lower)
    const resultUpper = getProxyAuthUser(upper)
    const resultExact = getProxyAuthUser(exact)

    expect(resultLower).not.toBeNull()
    expect(resultUpper).not.toBeNull()
    expect(resultExact).not.toBeNull()

    expect(resultExact!.id).toBe(1)
    expect(resultExact!.name).toBe('Test User')
    expect(resultExact!.email).toBe('test@example.com')
    expect(resultExact!.timezone).toBe('America/Chicago')
  })

  it('returns null and warns when user not found', () => {
    vi.stubEnv('OPENTASK_PROXY_AUTH_HEADER', 'X-Forwarded-User')
    const request = makeRequest({ 'X-Forwarded-User': 'nonexistent' })
    const result = getProxyAuthUser(request)
    expect(result).toBeNull()
  })

  it('uses the configured header name', () => {
    vi.stubEnv('OPENTASK_PROXY_AUTH_HEADER', 'Remote-User')

    // Wrong header name should return null
    const wrongHeader = makeRequest({ 'X-Forwarded-User': 'Test User' })
    expect(getProxyAuthUser(wrongHeader)).toBeNull()

    // Correct header name should match
    const rightHeader = makeRequest({ 'Remote-User': 'Test User' })
    expect(getProxyAuthUser(rightHeader)).not.toBeNull()
  })
})
