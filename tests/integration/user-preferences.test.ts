/**
 * Integration tests for user preference fields: wake_time, sleep_time, per-feature AI modes,
 * default_grouping, and a round trip for every other preference (the dashboard folds, the
 * snooze preferences, the quota-reminder pair)
 *
 * Tests GET/PATCH /api/user/preferences for the new preference fields,
 * including default values, valid updates, and validation rejections.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'

beforeAll(async () => {
  await resetTestData()
})

/**
 * §4.1 cadence ladder, P1 (Low) and P2 (Medium). GET once left both out, so
 * Settings — which hydrates from the GET — fell back to its client defaults
 * on every reload whatever was saved. This runs first, on the fresh user.
 */
describe('auto_snooze_low_minutes / auto_snooze_medium_minutes round trip', () => {
  async function readLadder() {
    const res = await apiFetch('/api/user/preferences')
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    return { low: data.auto_snooze_low_minutes, medium: data.auto_snooze_medium_minutes }
  }

  afterAll(async () => {
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { auto_snooze_low_minutes: 240, auto_snooze_medium_minutes: 60 },
    })
  })

  test('a fresh user reads the defaults: Low 240, Medium 60', async () => {
    expect(await readLadder()).toEqual({ low: 240, medium: 60 })
  })

  test('PATCH saves both, the response echoes them, and GET returns them', async () => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { auto_snooze_low_minutes: 90, auto_snooze_medium_minutes: 45 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.auto_snooze_low_minutes).toBe(90)
    expect(data.auto_snooze_medium_minutes).toBe(45)
    expect(await readLadder()).toEqual({ low: 90, medium: 45 })
  })
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
  test.each(['project', 'new', 'unified', 'slot'])('PATCH accepts %s', async (grouping) => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: grouping },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.default_grouping).toBe(grouping)
  })

  // All is the by-project view again since 2026-09-30, and the due-date
  // grouping ('time', All from 2026-09-29) is retired. An old client may still
  // send 'time': it is accepted, not refused, and stored as 'project' (All), so
  // the next GET — and the dashboard — say All.
  test('PATCH with the retired "time" value is stored as project', async () => {
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: 'slot' },
    })
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: 'time' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.default_grouping).toBe('project')
    const getRes = await apiFetch('/api/user/preferences')
    expect((await getRes.json()).data.default_grouping).toBe('project')
  })

  // 'recent' was the short-lived "Recent" view, replaced by just-added pinning.
  test.each(['reminders', 'recent'])(
    'PATCH with the retired "%s" value returns 400',
    async (retired) => {
      const before = (await (await apiFetch('/api/user/preferences')).json()).data.default_grouping
      const res = await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        body: { default_grouping: retired },
      })
      expect(res.status).toBe(400)

      // The last accepted value stands — a rejected update changes nothing.
      const getRes = await apiFetch('/api/user/preferences')
      const body = await getRes.json()
      expect(body.data.default_grouping).toBe(before)
      expect(before).not.toBe(retired)
    },
  )

  afterAll(async () => {
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_grouping: 'project' },
    })
  })
})

/**
 * `project_preview_count`: how many tasks each project group in All shows
 * before "Show all". Default 6; an integer from 1 to 50.
 */
describe('project_preview_count preference', () => {
  test('defaults to 6', async () => {
    const body = await (await apiFetch('/api/user/preferences')).json()
    expect(body.data.project_preview_count).toBe(6)
  })

  test.each([1, 12, 50])('PATCH accepts %s and GET reads it back', async (n) => {
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { project_preview_count: n },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.project_preview_count).toBe(n)
    const getRes = await apiFetch('/api/user/preferences')
    expect((await getRes.json()).data.project_preview_count).toBe(n)
  })

  test.each([0, 51, -3, 2.5, '8', null, true])(
    'PATCH with %j returns 400 and changes nothing',
    async (bad) => {
      await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        body: { project_preview_count: 9 },
      })
      const res = await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        body: { project_preview_count: bad },
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/project_preview_count/)
      const getRes = await apiFetch('/api/user/preferences')
      expect((await getRes.json()).data.project_preview_count).toBe(9)
    },
  )

  afterAll(async () => {
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { project_preview_count: 6 },
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
    // First day of the week: Sunday unless the user picks Monday.
    { field: 'week_start', initial: 'sunday', next: 'monday', invalid: 'tuesday' },
    { field: 'morning_time', initial: '09:00', next: '07:45', invalid: '24:00' },
    { field: 'default_snooze_option', initial: '60', next: 'tomorrow', invalid: '0' },
    { field: 'quota_prompts_enabled', initial: true, next: false, invalid: 'off' },
    // The quiet "AI finished" push for a just-added task: on unless turned off.
    { field: 'enrichment_notifications_enabled', initial: true, next: false, invalid: 1 },
    // The quiet push after a sweep from outside the app left High/Urgent overdue.
    { field: 'sweep_feedback_notifications_enabled', initial: true, next: false, invalid: 'off' },
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

/**
 * Changing `week_start` runs the period rollover for the user before the PATCH
 * answers, so a weekly quota the rollover has never seen is anchored at once,
 * on the new first day of the week. (What a CHANGE does to an existing anchor
 * depends on today's weekday; tests/behavioral/tr-week-start.test.ts covers
 * that with a frozen clock.)
 */
/**
 * The exact 400 messages of the shared range and HH:MM checks (`intInRange`,
 * `hhmm` in the route). Clients show these strings, so they are pinned word
 * for word, one field per ceiling.
 */
describe('validation messages are exact', () => {
  const cases: { body: Record<string, unknown>; error: string }[] = [
    {
      body: { auto_snooze_minutes: 0 },
      error: 'auto_snooze_minutes must be an integer between 1 and 360',
    },
    {
      body: { auto_snooze_urgent_minutes: 1.5 },
      error: 'auto_snooze_urgent_minutes must be an integer between 1 and 360',
    },
    {
      body: { auto_snooze_low_minutes: 1441 },
      error: 'auto_snooze_low_minutes must be an integer between 1 and 1440',
    },
    {
      body: { auto_snooze_medium_minutes: '60' },
      error: 'auto_snooze_medium_minutes must be an integer between 1 and 1440',
    },
    {
      body: { auto_snooze_high_minutes: 361 },
      error: 'auto_snooze_high_minutes must be an integer between 1 and 360',
    },
    { body: { morning_time: '9:00' }, error: 'morning_time must be in HH:MM format' },
    {
      body: { wake_time: '07:60' },
      error: 'wake_time must have valid hours (0-23) and minutes (0-59)',
    },
    { body: { sleep_time: 2200 }, error: 'sleep_time must be in HH:MM format' },
    { body: {}, error: 'No preferences to update' },
  ]

  test.each(cases)('$error', async ({ body, error }) => {
    const res = await apiFetch('/api/user/preferences', { method: 'PATCH', body })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(error)
  })

  test('the ceilings themselves are accepted', async () => {
    const before = (await (await apiFetch('/api/user/preferences')).json()).data
    const res = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { auto_snooze_low_minutes: 1440, auto_snooze_high_minutes: 360 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.auto_snooze_low_minutes).toBe(1440)
    expect(data.auto_snooze_high_minutes).toBe(360)
    await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: {
        auto_snooze_low_minutes: before.auto_snooze_low_minutes,
        auto_snooze_high_minutes: before.auto_snooze_high_minutes,
      },
    })
  })
})

describe('week_start anchors weekly quotas on the chosen day', () => {
  test('PATCH week_start: monday anchors a new weekly quota to Monday 00:00 local', async () => {
    const created = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Week-start probe', progress_target: 2, rrule: 'FREQ=WEEKLY' },
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()).data as { id: number }

    const patched = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { week_start: 'monday' },
    })
    expect(patched.status).toBe(200)

    const task = (await (await apiFetch(`/api/tasks/${id}`)).json()).data as {
      progress_period_start: string | null
    }
    expect(task.progress_period_start).not.toBeNull()
    const local = DateTime.fromISO(task.progress_period_start!).setZone('America/Chicago')
    // A Monday — unless the rollover cron happened to anchor it (to Sunday)
    // between the POST and the PATCH on a Sunday, when the Monday boundary is
    // still ahead and the Sunday anchor legitimately stands until then.
    const today = DateTime.now().setZone('America/Chicago')
    const sundayRace = today.weekday === 7 && local.equals(today.startOf('day'))
    if (!sundayRace) expect(local.toFormat('ccc HH:mm')).toBe('Mon 00:00')

    await apiFetch('/api/user/preferences', { method: 'PATCH', body: { week_start: 'sunday' } })
    await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' })
  })
})
