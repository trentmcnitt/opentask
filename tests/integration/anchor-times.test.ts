/**
 * Anchor times over HTTP (2026-10-21): Morning, Wake, Sleep and the number
 * pad's four buttons in GET/PATCH /api/user/preferences, each a custom time
 * or a link to one of the user's reminder periods (`src/lib/anchor-times.ts`).
 *
 * GET returns every time RESOLVED (a linked period's start) beside the slot
 * id it follows; PATCH links, unlinks and validates; a period retime is
 * followed at once, and a period delete keeps the time as custom and says so.
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

async function slotByLabel(label: string): Promise<Slot> {
  const slot = (await slots()).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot
}

async function prefs() {
  const res = await apiFetch('/api/user/preferences')
  expect(res.status).toBe(200)
  return (await res.json()).data
}

function patch(body: Record<string, unknown>) {
  return apiFetch('/api/user/preferences', { method: 'PATCH', body })
}

const DEFAULT_PAD = [
  { slot_id: null, time: '09:00' },
  { slot_id: null, time: '12:00' },
  { slot_id: null, time: '16:00' },
  { slot_id: null, time: '20:30' },
]

describe('anchor times in /api/user/preferences', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('a fresh user: custom times, no links, the default pad', async () => {
    const data = await prefs()
    expect(data.morning_slot_id).toBeNull()
    expect(data.wake_slot_id).toBeNull()
    expect(data.sleep_slot_id).toBeNull()
    expect(data.pad_presets).toEqual(DEFAULT_PAD)
  })

  test('linking Morning stores the period and reads its start; a retime is followed', async () => {
    const midday = await slotByLabel('Midday')
    const res = await patch({ morning_slot_id: midday.id })
    expect(res.status).toBe(200)
    const patched = (await res.json()).data
    expect(patched.morning_slot_id).toBe(midday.id)
    expect(patched.morning_time).toBe(midday.start_time)

    const moved = await apiFetch(`/api/time-slots/${midday.id}`, {
      method: 'PATCH',
      body: { start_time: '12:30' },
    })
    expect(moved.status).toBe(200)
    const data = await prefs()
    expect(data.morning_time).toBe('12:30')
    expect(data.morning_slot_id).toBe(midday.id)
  })

  test('a bare morning_time unlinks (an older client keeps working)', async () => {
    const midday = await slotByLabel('Midday')
    await patch({ morning_slot_id: midday.id })
    const res = await patch({ morning_time: '07:45' })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.morning_time).toBe('07:45')
    expect(data.morning_slot_id).toBeNull()
  })

  test('morning_slot_id: null alone unlinks at the time it reads now', async () => {
    const afternoon = await slotByLabel('Afternoon')
    await patch({ wake_slot_id: afternoon.id })
    const res = await patch({ wake_slot_id: null })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.wake_slot_id).toBeNull()
    expect(data.wake_time).toBe(afternoon.start_time)
  })

  test("a link must be the user's own period, and agree with a time sent beside it", async () => {
    const theirs = (await (await apiFetchB('/api/time-slots')).json()).data.time_slots as Slot[]
    const foreign = await patch({ sleep_slot_id: theirs[0].id })
    expect(foreign.status).toBe(400)
    expect((await foreign.json()).error).toBe('sleep_slot_id must be one of your reminder periods')

    const missing = await patch({ sleep_slot_id: 999999 })
    expect(missing.status).toBe(400)

    const bad = await patch({ morning_slot_id: 'x' })
    expect(bad.status).toBe(400)

    const midday = await slotByLabel('Midday')
    const disagree = await patch({ morning_slot_id: midday.id, morning_time: '06:00' })
    expect(disagree.status).toBe(400)
    const agree = await patch({ morning_slot_id: midday.id, morning_time: midday.start_time })
    expect(agree.status).toBe(200)
  })
})

describe('the number pad in /api/user/preferences', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('pad_presets: four custom or linked buttons, in order; null puts back the defaults', async () => {
    const evening = await slotByLabel('Evening')
    const res = await patch({
      pad_presets: [
        { time: '07:15' },
        { slot_id: evening.id },
        { time: '13:00' },
        { time: '18:00' },
      ],
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.pad_presets).toEqual([
      { slot_id: null, time: '07:15' },
      { slot_id: evening.id, time: evening.start_time },
      { slot_id: null, time: '13:00' },
      { slot_id: null, time: '18:00' },
    ])

    // GET's own shape round-trips.
    const echoed = await patch({ pad_presets: (await prefs()).pad_presets })
    expect(echoed.status).toBe(200)

    const reset = await patch({ pad_presets: null })
    expect((await reset.json()).data.pad_presets).toEqual(DEFAULT_PAD)
  })

  test('pad_preset sets one button and keeps the other three as stored', async () => {
    const evening = await slotByLabel('Evening')
    await patch({
      pad_presets: [
        { slot_id: evening.id },
        { time: '12:00' },
        { time: '16:00' },
        { time: '20:30' },
      ],
    })

    const res = await patch({ pad_preset: { index: 3, time: '07:15' } })
    expect(res.status).toBe(200)
    expect((await res.json()).data.pad_presets).toEqual([
      { slot_id: evening.id, time: evening.start_time },
      { slot_id: null, time: '12:00' },
      { slot_id: null, time: '16:00' },
      { slot_id: null, time: '07:15' },
    ])

    const linked = await patch({ pad_preset: { index: 1, slot_id: evening.id } })
    expect((await linked.json()).data.pad_presets[1]).toEqual({
      slot_id: evening.id,
      time: evening.start_time,
    })

    const badIndex = await patch({ pad_preset: { index: 4, time: '07:00' } })
    expect(badIndex.status).toBe(400)
    expect((await badIndex.json()).error).toBe('pad_preset.index must be an integer from 0 to 3')

    const both = await patch({ pad_preset: { index: 0, time: '07:00' }, pad_presets: null })
    expect(both.status).toBe(400)
  })

  test('pad_presets validation', async () => {
    const three = await patch({
      pad_presets: [{ time: '07:00' }, { time: '08:00' }, { time: '09:00' }],
    })
    expect(three.status).toBe(400)
    expect((await three.json()).error).toBe('pad_presets must be an array of 4 or null')

    const badTime = await patch({
      pad_presets: [{ time: '7:00' }, { time: '08:00' }, { time: '09:00' }, { time: '10:00' }],
    })
    expect(badTime.status).toBe(400)
    expect((await badTime.json()).error).toBe('pad_presets[0].time must be in HH:MM format')

    const theirs = (await (await apiFetchB('/api/time-slots')).json()).data.time_slots as Slot[]
    const foreign = await patch({
      pad_presets: [
        { time: '07:00' },
        { slot_id: theirs[0].id },
        { time: '09:00' },
        { time: '10:00' },
      ],
    })
    expect(foreign.status).toBe(400)
    expect((await foreign.json()).error).toBe(
      'pad_presets[1].slot_id must be one of your reminder periods',
    )
  })
})

describe('deleting a linked period', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('deleting a linked period keeps its time as custom and says so; undo puts the link back', async () => {
    const midday = await slotByLabel('Midday')
    await patch({ morning_slot_id: midday.id })

    const res = await apiFetch(`/api/time-slots/${midday.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.settings_converted).toEqual(['Default task time'])
    let data = await prefs()
    expect(data.morning_slot_id).toBeNull()
    expect(data.morning_time).toBe(midday.start_time)

    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    data = await prefs()
    expect(data.morning_slot_id).toBe(midday.id)
    expect(data.morning_time).toBe(midday.start_time)
  })
})
