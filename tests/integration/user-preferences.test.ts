/**
 * Integration tests for user preference fields: wake_time, sleep_time, per-feature AI modes
 *
 * Tests GET/PATCH /api/user/preferences for the new preference fields,
 * including default values, valid updates, and validation rejections.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

beforeAll(async () => {
  await resetTestData()
})

describe('wake_time preference', () => {
  test('GET returns default wake_time of 07:00', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('07:00')
  })

  test('PATCH with valid wake_time saves and returns updated value', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '06:30' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('06:30')
  })

  test('GET returns the updated wake_time', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('06:30')

    // Reset to default
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '07:00' },
    })
  })

  test('PATCH with 25:00 returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '25:00' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('wake_time')
  })

  test('PATCH with "9am" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '9am' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with "abc" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: 'abc' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with empty string returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with single-digit hour returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '9:00' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with invalid minutes returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '07:60' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('wake_time')
  })

  test('PATCH with 00:00 succeeds (midnight)', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '00:00' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('00:00')

    // Reset to default
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '07:00' },
    })
  })

  test('PATCH with 23:59 succeeds', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '23:59' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('23:59')

    // Reset to default
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { wake_time: '07:00' },
    })
  })
})

describe('sleep_time preference', () => {
  test('GET returns default sleep_time of 22:00', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.sleep_time).toBe('22:00')
  })

  test('PATCH with valid sleep_time saves and returns updated value', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '23:30' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.sleep_time).toBe('23:30')
  })

  test('GET returns the updated sleep_time', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.sleep_time).toBe('23:30')

    // Reset to default
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '22:00' },
    })
  })

  test('PATCH with 25:00 returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '25:00' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('sleep_time')
  })

  test('PATCH with "10pm" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '10pm' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with "abc" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: 'abc' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with empty string returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })

  test('PATCH with invalid minutes returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: '22:99' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('sleep_time')
  })

  test('PATCH with numeric value returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sleep_time: 2200 },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('HH:MM')
  })
})

describe('per-feature AI mode preferences', () => {
  test('GET returns default per-feature modes of api', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_enrichment_mode).toBe('api')
    expect(body.data.ai_quicktake_mode).toBe('api')
    expect(body.data.ai_whats_next_mode).toBe('api')
    expect(body.data.ai_insights_mode).toBe('api')
  })

  test('PATCH ai_whats_next_mode to off saves and returns updated value', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_mode: 'off' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_mode).toBe('off')
  })

  test('GET returns the updated ai_whats_next_mode', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_mode).toBe('off')
  })

  test('PATCH back to api succeeds', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_mode: 'api' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_mode).toBe('api')
  })

  test('PATCH with invalid mode returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_mode: 'gpt-4' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_mode')
  })

  test('PATCH with empty string returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_insights_mode: '' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_insights_mode')
  })

  test('PATCH with numeric value returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_enrichment_mode: 123 },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_enrichment_mode')
  })

  test('PATCH with null returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_quicktake_mode: null },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_quicktake_mode')
  })
})

describe('combined preference updates', () => {
  test('PATCH with wake_time, sleep_time, and ai_whats_next_mode together', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        wake_time: '08:00',
        sleep_time: '23:00',
        ai_whats_next_mode: 'off',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('08:00')
    expect(body.data.sleep_time).toBe('23:00')
    expect(body.data.ai_whats_next_mode).toBe('off')

    // Reset all to defaults
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        wake_time: '07:00',
        sleep_time: '22:00',
        ai_whats_next_mode: 'api',
      },
    })
  })

  test('PATCH with one valid and one invalid field returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        wake_time: '06:00',
        sleep_time: 'invalid',
      },
    })
    expect(res.status).toBe(400)

    // Verify wake_time was not changed (atomic rejection)
    const getRes = await apiFetch('/api/user/preferences')
    const body = await getRes.json()
    expect(body.data.wake_time).toBe('07:00')
  })
})
