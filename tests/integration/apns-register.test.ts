/**
 * APNs Device Registration Integration Tests
 *
 * Tests the POST/DELETE /api/push/apns/register endpoints.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiAnon, resetTestData } from './helpers'

describe('APNs device registration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST /api/push/apns/register requires auth', async () => {
    const res = await apiAnon('/api/push/apns/register', {
      method: 'POST',
      body: { device_token: 'test-token', bundle_id: 'io.mcnitt.opentask' },
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/push/apns/register requires device_token', async () => {
    const res = await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: { bundle_id: 'io.mcnitt.opentask' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/push/apns/register requires bundle_id', async () => {
    const res = await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: { device_token: 'test-token' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/push/apns/register succeeds with valid data', async () => {
    const res = await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: { device_token: 'integration-test-token', bundle_id: 'io.mcnitt.opentask' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.registered).toBe(true)
  })

  test('POST /api/push/apns/register upserts on same device_token', async () => {
    // Register with production
    await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: {
        device_token: 'upsert-test-token',
        bundle_id: 'io.mcnitt.opentask',
        environment: 'production',
      },
    })

    // Re-register same token with development
    const res = await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: {
        device_token: 'upsert-test-token',
        bundle_id: 'io.mcnitt.opentask',
        environment: 'development',
      },
    })
    expect(res.status).toBe(200)
  })

  test('DELETE /api/push/apns/register requires auth', async () => {
    const res = await apiAnon('/api/push/apns/register', {
      method: 'DELETE',
      body: { device_token: 'test-token' },
    })
    expect(res.status).toBe(401)
  })

  test('DELETE /api/push/apns/register requires device_token', async () => {
    const res = await apiFetch('/api/push/apns/register', {
      method: 'DELETE',
      body: {},
    })
    expect(res.status).toBe(400)
  })

  test('DELETE /api/push/apns/register succeeds', async () => {
    // Register first
    await apiFetch('/api/push/apns/register', {
      method: 'POST',
      body: { device_token: 'delete-test-token', bundle_id: 'io.mcnitt.opentask' },
    })

    // Delete
    const res = await apiFetch('/api/push/apns/register', {
      method: 'DELETE',
      body: { device_token: 'delete-test-token' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.unregistered).toBe(true)
  })
})
