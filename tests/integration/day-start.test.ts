/**
 * "Day starts at" over HTTP (2026-10-23): GET/PATCH /api/user/preferences
 * `day_start_time` / `day_start_slot_id` / `day_start_default` and
 * `rollover_time` (the same resolved time), validation, a period delete
 * converting a link with undo, and — with the task queue on — the Reminders
 * screen counting its day from it (`prompt_key` dates and the stale-key 400).
 *
 * Time-agnostic: the expected OpenTask day is computed from the clock at the
 * request with the server's own rule (`openTaskDayOf`), and the day start
 * chosen is at least half an hour from now, so no test straddles a boundary.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { openTaskDayOf } from '@/lib/opentask-day'
import { apiFetch, resetTestData, setTaskQueue } from './helpers'

const TZ = 'America/Chicago' // user A (scripts/seed-test.ts)

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(): Promise<Slot[]> {
  const list = (await (await apiFetch('/api/time-slots')).json()).data.time_slots as Slot[]
  return [...list].sort((a, b) => a.start_time.localeCompare(b.start_time))
}

async function prefs() {
  const res = await apiFetch('/api/user/preferences')
  expect(res.status).toBe(200)
  return (await res.json()).data
}

function patch(body: Record<string, unknown>) {
  return apiFetch('/api/user/preferences', { method: 'PATCH', body })
}

/**
 * A day start that puts now on an OpenTask day OTHER than the calendar date,
 * at least half an hour from either boundary: before 11:00, 11:59 (at or
 * before noon, not reached yet — still yesterday's day); from 13:00, 12:30
 * (after noon, already passed — tomorrow's day). Between 11:00 and 13:00
 * neither exists; 23:59 then (today's day, the stale check skipped).
 */
function awayFromToday(): string {
  const hour = DateTime.now().setZone(TZ).hour
  if (hour < 11) return '11:59'
  if (hour >= 13) return '12:30'
  return '23:59'
}

describe('"Day starts at" in /api/user/preferences', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('a fresh user reads the 3:00 AM default — not the first period', async () => {
    const [first] = await slots()
    expect(first.start_time).not.toBe('03:00')
    const data = await prefs()
    expect(data).toMatchObject({
      day_start_time: '03:00',
      day_start_slot_id: null,
      day_start_default: true,
      rollover_time: '03:00',
    })
    expect(data).not.toHaveProperty('day_start_first_period')
  })

  test('custom (11 PM), linked, unlinked, and back to the default', async () => {
    let res = await patch({ day_start_time: '23:00' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      day_start_time: '23:00',
      day_start_slot_id: null,
      day_start_default: false,
      rollover_time: '23:00',
    })

    const evening = (await slots()).find((s) => s.label === 'Evening')!
    res = await patch({ day_start_slot_id: evening.id })
    expect((await res.json()).data).toMatchObject({
      day_start_time: evening.start_time,
      day_start_slot_id: evening.id,
      day_start_default: false,
    })

    // Unlink: at the time it reads now, so nothing jumps.
    res = await patch({ day_start_slot_id: null })
    expect((await res.json()).data).toMatchObject({
      day_start_time: evening.start_time,
      day_start_slot_id: null,
      day_start_default: false,
    })

    res = await patch({ day_start_time: null })
    expect((await res.json()).data).toMatchObject({
      day_start_time: '03:00',
      day_start_slot_id: null,
      day_start_default: true,
      rollover_time: '03:00',
    })
  })

  test('validation', async () => {
    expect((await patch({ day_start_time: '25:00' })).status).toBe(400)
    expect((await patch({ day_start_time: '3am' })).status).toBe(400)
    expect((await patch({ day_start_slot_id: 999999 })).status).toBe(400)
    expect((await patch({ day_start_time: null, day_start_slot_id: 1 })).status).toBe(400)
    const [first] = await slots()
    const mismatch = await patch({ day_start_slot_id: first.id, day_start_time: '01:00' })
    expect(mismatch.status).toBe(400)
  })

  test('deleting the linked period keeps its time as custom; undo relinks', async () => {
    const midday = (await slots()).find((s) => s.label === 'Midday')!
    await patch({ day_start_slot_id: midday.id })
    const res = await apiFetch(`/api/time-slots/${midday.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.settings_converted).toEqual(['Day start time'])
    expect(await prefs()).toMatchObject({
      day_start_time: midday.start_time,
      day_start_slot_id: null,
      day_start_default: false,
    })
    expect((await apiFetch('/api/undo', { method: 'POST' })).status).toBe(200)
    expect((await prefs()).day_start_slot_id).toBe(midday.id)
  })
})

describe('the Reminders screen counts its day from it (task queue on)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })
  afterAll(async () => {
    await setTaskQueue(false)
  })

  test("prompt keys carry the OpenTask day, and another day's key is a 400", async () => {
    // A day start that names now by another date (either direction).
    const dayStart = awayFromToday()
    await patch({ day_start_time: dayStart })
    const quota = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Stretch', rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true },
    })
    expect(quota.status).toBe(201)
    const id = (await quota.json()).data.id as number

    const expected = openTaskDayOf(new Date(), TZ, dayStart)
    const reminders = (await (await apiFetch('/api/reminders')).json()).data
    const keys = (reminders.groups as { prompts: { prompt_key: string; task_id: number }[] }[])
      .flatMap((g) => g.prompts)
      .filter((p) => p.task_id === id)
      .map((p) => p.prompt_key)
    expect(keys).toEqual([`q:${id}:0:${expected}`])

    const calendar = DateTime.now().setZone(TZ).toISODate()!
    // (Equal only between 11:00 and 13:00, when neither direction exists.)
    if (calendar !== expected) {
      // The calendar date's key is another day's: refused.
      const stale = await apiFetch('/api/quota-prompts/consider', {
        method: 'POST',
        body: { keys: [`q:${id}:0:${calendar}`] },
      })
      expect(stale.status).toBe(400)
    }
    const ok = await apiFetch('/api/quota-prompts/consider', {
      method: 'POST',
      body: { keys: [`q:${id}:0:${expected}`] },
    })
    expect(ok.status).toBe(200)
  })
})
