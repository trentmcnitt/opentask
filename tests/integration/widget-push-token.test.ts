/**
 * WidgetKit Push Token Registration Integration Tests
 *
 * Tests the POST/DELETE /api/push/apns/widget-token endpoints.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiAnon, resetTestData } from './helpers'

describe('Widget push token registration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST /api/push/apns/widget-token requires auth', async () => {
    const res = await apiAnon('/api/push/apns/widget-token', {
      method: 'POST',
      body: { push_token: 'test-token', bundle_id: 'io.mcnitt.opentask', platform: 'ios' },
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/push/apns/widget-token requires push_token', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: { bundle_id: 'io.mcnitt.opentask', platform: 'ios' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/push/apns/widget-token requires bundle_id', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: { push_token: 'test-token', platform: 'ios' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/push/apns/widget-token requires a valid platform', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: { push_token: 'test-token', bundle_id: 'io.mcnitt.opentask', platform: 'windows' },
    })
    expect(res.status).toBe(400)
  })

  test('POST /api/push/apns/widget-token succeeds with valid data', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'integration-widget-token',
        bundle_id: 'io.mcnitt.opentask',
        platform: 'ios',
        widget_kind: 'OpenTaskTasks',
      },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.registered).toBe(true)
  })

  test('POST /api/push/apns/widget-token upserts on same push_token', async () => {
    // Register from the Tasks widget's handler instance
    await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'upsert-widget-token',
        bundle_id: 'io.mcnitt.opentask',
        platform: 'ios',
        widget_kind: 'OpenTaskTasks',
        environment: 'production',
      },
    })

    // Re-register the same token, e.g. from the Reminders widget's handler
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'upsert-widget-token',
        bundle_id: 'io.mcnitt.opentask',
        platform: 'ios',
        widget_kind: 'OpenTaskReminders',
        environment: 'development',
      },
    })
    expect(res.status).toBe(200)
  })

  test('POST /api/push/apns/widget-token accepts macOS platform', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'mac-widget-token',
        bundle_id: 'io.mcnitt.opentask.mac',
        platform: 'macos',
      },
    })
    expect(res.status).toBe(200)
  })

  test('POST /api/push/apns/widget-token accepts watchOS platform', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'watch-widget-token',
        bundle_id: 'io.mcnitt.opentask.watchapp',
        platform: 'watchos',
        environment: 'development',
        widget_kind: 'OpenTaskWatchReminders',
      },
    })
    expect(res.status).toBe(200)
  })

  test('DELETE /api/push/apns/widget-token requires auth', async () => {
    const res = await apiAnon('/api/push/apns/widget-token', {
      method: 'DELETE',
      body: { push_token: 'test-token' },
    })
    expect(res.status).toBe(401)
  })

  test('DELETE /api/push/apns/widget-token requires push_token', async () => {
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'DELETE',
      body: {},
    })
    expect(res.status).toBe(400)
  })

  test('DELETE /api/push/apns/widget-token succeeds', async () => {
    // Register first
    await apiFetch('/api/push/apns/widget-token', {
      method: 'POST',
      body: {
        push_token: 'delete-widget-token',
        bundle_id: 'io.mcnitt.opentask',
        platform: 'ios',
      },
    })

    // Delete (this is what OpenTaskWidgetPushHandler calls when `widgets` comes back empty)
    const res = await apiFetch('/api/push/apns/widget-token', {
      method: 'DELETE',
      body: { push_token: 'delete-widget-token' },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.unregistered).toBe(true)
  })
})
