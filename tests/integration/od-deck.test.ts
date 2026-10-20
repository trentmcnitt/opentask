/**
 * On deck over HTTP (2026-10-20; POST /api/tasks/deck, PATCH /api/tasks/:id
 * `on_deck_day`, bulk edit, GET /api/reminders?deck=1).
 *
 * The server runs with OPENTASK_TASK_QUEUE off, as every other file expects;
 * this file turns it on through the test-only switch and off again after.
 * Clock-independent: deck days are User A's (America/Chicago) calendar today
 * and days after it, and every target is days away.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, apiFetchB, resetTestData, setTaskQueue } from './helpers'

const DAY = 24 * 3600 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()
/** User A's calendar day, `n` days from today (yyyy-MM-dd). */
const day = (n: number) => DateTime.now().setZone('America/Chicago').plus({ days: n }).toISODate()!

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

async function deck(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks/deck', { method: 'POST', body })
  return { status: res.status, json: await res.json() }
}

async function patch(id: number, body: Record<string, unknown>) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  return { status: res.status, json: await res.json() }
}

describe('On deck over HTTP', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('OD-I01: one task, the default day: today; the target dropped; Undo puts it back', async () => {
    const id = await make({ title: 'Grab the winter gloves', target_at: daysFromNow(2) })
    const target = (await getTask(id)).target_at
    const r = await deck({ ids: [id] })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      day: day(0),
      decked: 1,
      undecked: 0,
      refused: [],
      summary: '1 task on deck for today',
    })
    expect(await getTask(id)).toMatchObject({ on_deck_day: day(0), target_at: null, due_at: null })
    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    expect(await getTask(id)).toMatchObject({ on_deck_day: null, target_at: target })
  })

  test('OD-I02: bulk — skipped and refused per task, never the batch', async () => {
    const a = await make({ title: 'One' })
    const b = await make({ title: 'Two' })
    const weekly = await make({
      title: 'Water the ferns',
      rrule: 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0',
    })
    const reminder = await make({ title: 'Stretch', is_reminder: true, rrule: null })
    // A deadline two days out: its automatic target has already arrived.
    const nagging = await make({ title: 'Cancel the trial', deadline_at: daysFromNow(2) })
    const r = await deck({ ids: [a, b, weekly, reminder, nagging], day: day(1) })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      day: day(1),
      decked: 2,
      skipped_recurring: 1,
      skipped_reminder: 1,
      refused: [{ id: nagging, reason: 'deadline_nagging' }],
    })
    expect((await getTask(a)).on_deck_day).toBe(day(1))
    expect((await getTask(weekly)).on_deck_day).toBeNull()
  })

  test('OD-I03: day null takes tasks off deck', async () => {
    const id = await make({ title: 'One' })
    await deck({ ids: [id], day: day(3) })
    const r = await deck({ ids: [id], day: null })
    expect(r.json.data).toMatchObject({ day: null, undecked: 1 })
    expect((await getTask(id)).on_deck_day).toBeNull()
  })

  test('OD-I04: 400 — a past day, a bad date, no ids, someone else’s task', async () => {
    const id = await make({ title: 'One' })
    expect((await deck({ ids: [id], day: day(-1) })).status).toBe(400)
    expect((await deck({ ids: [id], day: 'Saturday' })).status).toBe(400)
    expect((await deck({ ids: [] })).status).toBe(400)
    const other = await apiFetchB('/api/tasks', { method: 'POST', body: { title: 'B task' } })
    const otherId = (await other.json()).data.id
    expect((await deck({ ids: [id, otherId] })).status).toBe(400)
    expect((await getTask(id)).on_deck_day).toBeNull()
  })

  test('OD-I05: 409 with the task queue off, for the endpoint and a PATCH deck', async () => {
    const id = await make({ title: 'One' })
    await setTaskQueue(false)
    expect((await deck({ ids: [id] })).status).toBe(409)
    expect((await patch(id, { on_deck_day: day(0) })).status).toBe(409)
  })

  test('OD-I06: PATCH on_deck_day; a target in the same body is a 400; a pick clears the deck', async () => {
    const id = await make({ title: 'One' })
    const both = await patch(id, { on_deck_day: day(1), target_at: daysFromNow(3) })
    expect(both.status).toBe(400)
    expect((await patch(id, { on_deck_day: day(1), due_at: daysFromNow(3) })).status).toBe(400)
    expect((await patch(id, { on_deck_day: day(1), deadline_at: daysFromNow(9) })).status).toBe(400)
    const ok = await patch(id, { on_deck_day: day(1) })
    expect(ok.status).toBe(200)
    expect(ok.json.data).toMatchObject({ on_deck_day: day(1) })
    expect(ok.json.data.fields_changed).toContain('on_deck_day')
    // A pick clears it, in the same write.
    const picked = await patch(id, { target_at: daysFromNow(3) })
    expect(picked.json.data).toMatchObject({ on_deck_day: null })
    expect(picked.json.data.fields_changed).toContain('on_deck_day')
    // Null takes it off; a repeating task can't go on deck.
    await patch(id, { on_deck_day: day(2) })
    expect((await patch(id, { on_deck_day: null })).json.data.on_deck_day).toBeNull()
    const weekly = await make({ title: 'Weekly', rrule: 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0' })
    expect((await patch(weekly, { on_deck_day: day(1) })).status).toBe(400)
  })

  test('OD-I07: bulk edit takes on_deck_day; with a date in the same changes it is a 400', async () => {
    const a = await make({ title: 'One' })
    const b = await make({ title: 'Two' })
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [a, b], changes: { on_deck_day: day(2) } },
    })
    expect(res.status).toBe(200)
    expect((await getTask(a)).on_deck_day).toBe(day(2))
    expect((await getTask(b)).on_deck_day).toBe(day(2))
    const bad = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [a], changes: { on_deck_day: day(2), target_at: daysFromNow(1) } },
    })
    expect(bad.status).toBe(400)
  })

  test('OD-I08: GET /api/reminders?deck=1 lists a future deck in Upcoming on its heads-up day only', async () => {
    const id = await make({ title: 'One' })
    // Decked today for tomorrow: wait 1, no heads-up — and never in a horizon segment.
    await deck({ ids: [id], day: day(1) })
    type Segs = { data: { task_segments: { horizon: string; tasks: { id: number }[] }[] } }
    const where = async (q: string) =>
      ((await (await apiFetch(`/api/reminders${q}`)).json()) as Segs).data.task_segments
        .filter((s) => s.tasks.some((t) => t.id === id))
        .map((s) => s.horizon)
    expect(await where('?queue=1&deck=1')).toEqual([])
    expect(await where('')).toEqual([])
  })
})
