/**
 * Integration tests for user preference fields: wake_time, sleep_time, ai_whats_next_model
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

describe('ai_whats_next_model preference', () => {
  test('GET returns default ai_whats_next_model of haiku', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_model).toBe('haiku')
  })

  test('PATCH with claude-opus-4-6 saves and returns updated value', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: 'claude-opus-4-6' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_model).toBe('claude-opus-4-6')
  })

  test('GET returns the updated ai_whats_next_model', async () => {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_model).toBe('claude-opus-4-6')
  })

  test('PATCH back to haiku succeeds', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: 'haiku' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ai_whats_next_model).toBe('haiku')
  })

  test('PATCH with "gpt-4" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: 'gpt-4' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_model')
  })

  test('PATCH with "sonnet" returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: 'sonnet' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_model')
  })

  test('PATCH with empty string returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: '' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_model')
  })

  test('PATCH with numeric value returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: 123 },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_model')
  })

  test('PATCH with null returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { ai_whats_next_model: null },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('ai_whats_next_model')
  })
})

describe('combined preference updates', () => {
  test('PATCH with wake_time, sleep_time, and ai_whats_next_model together', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        wake_time: '08:00',
        sleep_time: '23:00',
        ai_whats_next_model: 'claude-opus-4-6',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wake_time).toBe('08:00')
    expect(body.data.sleep_time).toBe('23:00')
    expect(body.data.ai_whats_next_model).toBe('claude-opus-4-6')

    // Reset all to defaults
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        wake_time: '07:00',
        sleep_time: '22:00',
        ai_whats_next_model: 'haiku',
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
