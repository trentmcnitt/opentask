/**
 * Integration tests for user preference fields: wake_time, sleep_time, per-feature AI modes,
 * default_grouping, and a round trip for every other preference (the dashboard folds, the
 * snooze preferences, the quota-reminder pair)
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

/**
 * `default_grouping` used to accept 'reminders' — the §6 surface rode in the
 * dashboard's view toggle and persisted through this preference. It is now its own
 * route (`/reminders`), so the value is no longer a grouping the dashboard can
 * render and the API must stop accepting it.
 */
describe('default_grouping preference', () => {
  test.each(['time', 'project', 'unified', 'slot'])('PATCH accepts %s', async (grouping) => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: grouping },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.default_grouping).toBe(grouping)
  })

  test('PATCH with the retired "reminders" value returns 400', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: 'reminders' },
    })
    expect(res.status).toBe(400)

    // The last accepted value stands — a rejected update changes nothing.
    const getRes = await apiFetch('/api/user/preferences')
    const body = await getRes.json()
    expect(body.data.default_grouping).toBe('slot')

    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: 'project' },
    })
  })
})

/**
 * Round trips for the preferences the rest of this file doesn't cover: the
 * dashboard's two folds (saved fire-and-forget by PreferencesProvider), the
 * snooze preferences, and the quota-reminder pair. Each one: the default, a
 * PATCH that echoes the new value, a GET that reads it back, a bad value
 * refused with 400 and nothing changed, then a reset to the default so later
 * tests start clean.
 */
describe('round trip: every remaining preference', () => {
  const cases: {
    field: string
    initial: unknown
    next: unknown
    invalid: unknown
  }[] = [
    { field: 'filters_expanded', initial: false, next: true, invalid: 'yes' },
    { field: 'track_expanded', initial: false, next: true, invalid: 1 },
    // /quotas opens on the summary panel for a user who never chose.
    { field: 'quotas_details', initial: false, next: true, invalid: 'yes' },
    {
      field: 'bulk_snooze_default',
      initial: 'next_period',
      next: 'default_option',
      invalid: 'later',
    },
    { field: 'morning_time', initial: '09:00', next: '07:45', invalid: '24:00' },
    { field: 'default_snooze_option', initial: '60', next: 'tomorrow', invalid: '0' },
    { field: 'quota_prompts_enabled', initial: true, next: false, invalid: 'off' },
  ]

  async function readPref(field: string): Promise<unknown> {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    return (await res.json()).data[field]
  }

  test.each(cases)('$field saves, reads back, and rejects a bad value', async (c) => {
    expect(await readPref(c.field)).toBe(c.initial)

    const patched = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { [c.field]: c.next },
    })
    expect(patched.status).toBe(200)
    expect((await patched.json()).data[c.field]).toBe(c.next)
    expect(await readPref(c.field)).toBe(c.next)

    const refused = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { [c.field]: c.invalid },
    })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain(c.field)
    expect(await readPref(c.field)).toBe(c.next)

    const reset = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { [c.field]: c.initial },
    })
    expect(reset.status).toBe(200)
    expect(await readPref(c.field)).toBe(c.initial)
  })

  test('default_snooze_option also takes a minute count', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_snooze_option: '90' },
    })
    expect(res.status).toBe(200)
    expect(await readPref('default_snooze_option')).toBe('90')
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_snooze_option: '60' },
    })
  })

  test('quota_prompt_slot_id saves one of the user’s periods, reads back, and clears to null', async () => {
    expect(await readPref('quota_prompt_slot_id')).toBeNull()
    const slots = (await (await apiFetch('/api/time-slots')).json()).data.time_slots as {
      id: number
    }[]
    const slotId = slots[slots.length - 1].id

    const patched = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: slotId },
    })
    expect(patched.status).toBe(200)
    expect((await patched.json()).data.quota_prompt_slot_id).toBe(slotId)
    expect(await readPref('quota_prompt_slot_id')).toBe(slotId)

    const refused = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: 'evening' },
    })
    expect(refused.status).toBe(400)
    expect(await readPref('quota_prompt_slot_id')).toBe(slotId)

    const cleared = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: null },
    })
    expect(cleared.status).toBe(200)
    expect(await readPref('quota_prompt_slot_id')).toBeNull()
  })

  test('the dashboard folds save independently: one PATCH never touches the other', async () => {
    await apiFetch('/api/user/preferences', { method: 'PATCH', body: { track_expanded: true } })
    await apiFetch('/api/user/preferences', { method: 'PATCH', body: { filters_expanded: true } })
    expect(await readPref('track_expanded')).toBe(true)
    expect(await readPref('filters_expanded')).toBe(true)

    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { track_expanded: false, filters_expanded: false },
    })
  })
})
