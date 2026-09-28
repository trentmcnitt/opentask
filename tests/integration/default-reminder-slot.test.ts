/**
 * The default reminder slot over HTTP (Trent, 2026-09-28)
 *
 * An Apple Shortcut POSTs `{title, is_reminder: true}` and nothing else. The
 * reminder must land in the user's default reminder slot at once — daily at
 * its start — rather than in "Anytime". The setting is `quota_prompt_slot_id`
 * in /api/user/preferences, also readable and writable as
 * `default_reminder_slot_id`.
 *
 * The integration server runs with AI disabled, so this is the "AI off" path:
 * the reminder stays in the default slot and carries no `ai-to-process`. The
 * AI-on path (label added, enrichment keeps or moves it) is behavioral —
 * tests/behavioral/rm-default-slot.test.ts.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(): Promise<Slot[]> {
  return (await (await apiFetch('/api/time-slots')).json()).data.time_slots as Slot[]
}

function dailyAt(slot: Slot): string {
  const [hour, minute] = slot.start_time.split(':').map(Number)
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`
}

async function createReminder(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data as {
    id: number
    is_reminder: boolean
    rrule: string | null
    anchor_time: string | null
    labels: string[]
  }
}

describe('POST /api/tasks — a reminder with no schedule', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('title only → the first period when no default is set', async () => {
    const [first] = await slots()
    const task = await createReminder({ title: 'notice what I am grateful for', is_reminder: true })
    expect(task.is_reminder).toBe(true)
    expect(task.rrule).toBe(dailyAt(first))
    expect(task.labels).not.toContain('ai-to-process')
  })

  test('title only → the chosen default slot', async () => {
    const all = await slots()
    const evening = all[all.length - 1]
    const set = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_reminder_slot_id: evening.id },
    })
    expect(set.status).toBe(200)

    const task = await createReminder({ title: 'write one good thing down', is_reminder: true })
    expect(task.rrule).toBe(dailyAt(evening))
    expect(task.anchor_time).toBe(evening.start_time)
  })

  test('an explicit rrule is used as sent; an explicit null stays unscheduled', async () => {
    const withRule = await createReminder({
      title: 'stretch',
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=9',
    })
    expect(withRule.rrule).toBe('FREQ=DAILY;BYHOUR=9')

    const once = await createReminder({ title: 'one-off', is_reminder: true, rrule: null })
    expect(once.rrule).toBeNull()
  })

  test('a plain task never gets the default', async () => {
    const task = await createReminder({ title: 'buy milk' })
    expect(task.rrule).toBeNull()
  })
})

describe('/api/user/preferences — default_reminder_slot_id', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('the alias and the original field are one setting, both ways', async () => {
    const all = await slots()
    const slotId = all[1].id

    const viaAlias = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_reminder_slot_id: slotId },
    })
    expect(viaAlias.status).toBe(200)
    const data = (await viaAlias.json()).data
    expect(data.default_reminder_slot_id).toBe(slotId)
    expect(data.quota_prompt_slot_id).toBe(slotId)

    const viaOriginal = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { quota_prompt_slot_id: null },
    })
    expect(viaOriginal.status).toBe(200)
    const read = (await (await apiFetch('/api/user/preferences')).json()).data
    expect(read.default_reminder_slot_id).toBeNull()
    expect(read.quota_prompt_slot_id).toBeNull()
  })

  test('refuses conflicting values, junk, and another user’s slot', async () => {
    const all = await slots()
    const conflict = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_reminder_slot_id: all[0].id, quota_prompt_slot_id: all[1].id },
    })
    expect(conflict.status).toBe(400)

    const junk = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_reminder_slot_id: 'evening' },
    })
    expect(junk.status).toBe(400)

    const theirs = (await (await apiFetchB('/api/time-slots')).json()).data.time_slots as Slot[]
    const foreign = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { default_reminder_slot_id: theirs[0].id },
    })
    expect(foreign.status).toBe(400)

    const read = (await (await apiFetch('/api/user/preferences')).json()).data
    expect(read.default_reminder_slot_id).toBeNull()
  })
})
