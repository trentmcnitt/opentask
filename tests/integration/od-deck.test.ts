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
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    })
    const reminder = await make({ title: 'Stretch', is_reminder: true, rrule: null })
    // A deadline two days out: its automatic target has already arrived.
    const nagging = await make({ title: 'Cancel the trial', deadline_at: daysFromNow(2) })
    const r = await deck({ ids: [a, b, weekly, reminder, nagging], day: day(1) })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      day: day(1),
      // A repeating task is decked too since 2026-10-20 (`skipped_recurring` stays, 0).
      decked: 3,
      skipped_recurring: 0,
      skipped_reminder: 1,
      refused: [{ id: nagging, reason: 'deadline_nagging' }],
    })
    expect((await getTask(a)).on_deck_day).toBe(day(1))
    expect(await getTask(weekly)).toMatchObject({ on_deck_day: day(1), target_at: null })
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
    // A deadline may come with it (D2 review): one write, A1 against that deadline.
    const withDeadline = await patch(id, { on_deck_day: day(1), deadline_at: daysFromNow(9) })
    expect(withDeadline.status).toBe(200)
    expect(withDeadline.json.data).toMatchObject({ on_deck_day: day(1) })
    expect(withDeadline.json.data.deadline_at).not.toBeNull()
    await patch(id, { on_deck_day: null, deadline_at: null })
    const ok = await patch(id, { on_deck_day: day(1) })
    expect(ok.status).toBe(200)
    expect(ok.json.data).toMatchObject({ on_deck_day: day(1) })
    expect(ok.json.data.fields_changed).toContain('on_deck_day')
    // A pick clears it, in the same write.
    const picked = await patch(id, { target_at: daysFromNow(3) })
    expect(picked.json.data).toMatchObject({ on_deck_day: null })
    expect(picked.json.data.fields_changed).toContain('on_deck_day')
    // Null takes it off. A repeating task can go on deck — but not with a rule in the body.
    await patch(id, { on_deck_day: day(2) })
    expect((await patch(id, { on_deck_day: null })).json.data.on_deck_day).toBeNull()
    const weekly = await make({
      title: 'Weekly',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    })
    const withRule = await patch(weekly, {
      on_deck_day: day(1),
      rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0',
    })
    expect(withRule.status).toBe(400)
    expect((await patch(weekly, { on_deck_day: day(1) })).status).toBe(200)
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

describe('On deck over HTTP: repeating tasks (2026-10-20)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('OD-I11: a repeating task on deck — no target while decked, never over target, back on un-deck', async () => {
    // A daily moved to a target already passed: over target.
    const daily = await make({ title: 'Water the ferns', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    await patch(daily, { target_at: daysFromNow(-1) })
    const before = await getTask(daily)
    const overdueIds = async () =>
      (
        (await (await apiFetch('/api/tasks?overdue=true&limit=1000')).json()).data.tasks as {
          id: number
        }[]
      ).map((t) => t.id)
    const overdueCount = async () =>
      (await (await apiFetch('/api/tasks/counts')).json()).data.overdue as number
    expect(await overdueIds()).toContain(daily)
    const countBefore = await overdueCount()
    const r = await deck({ ids: [daily] })
    expect(r.json.data).toMatchObject({ decked: 1, skipped_recurring: 0 })
    const decked = await getTask(daily)
    expect(decked).toMatchObject({
      on_deck_day: day(0),
      target_at: null,
      due_at: null,
      occurrence_at: before.occurrence_at,
    })
    expect(await overdueIds()).not.toContain(daily)
    expect(await overdueCount()).toBe(countBefore - 1)
    // Off deck: the target is back on the scheduled occurrence (not the moved target).
    const off = await deck({ ids: [daily], day: null })
    expect(off.json.data.undecked).toBe(1)
    expect(await getTask(daily)).toMatchObject({
      on_deck_day: null,
      target_at: before.occurrence_at,
      occurrence_at: before.occurrence_at,
    })
  })
})

describe('On deck over HTTP: review fixes (10-20)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('OD-I09: POST /api/tasks creates on deck; with a target it is a 400; switch off 409', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Grab the gloves', on_deck_day: day(1) },
    })
    expect(res.status).toBe(201)
    const created = (await res.json()).data
    expect(created).toMatchObject({ on_deck_day: day(1), target_at: null })
    const both = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'x', on_deck_day: day(1), target_at: daysFromNow(2) },
    })
    expect(both.status).toBe(400)
    const past = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'x', on_deck_day: day(-1) },
    })
    expect(past.status).toBe(400)
    // A deadline two days out already reminds: no deck.
    const near = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'x', on_deck_day: day(0), deadline_at: daysFromNow(2) },
    })
    expect(near.status).toBe(400)
    await setTaskQueue(false)
    const off = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'x', on_deck_day: day(1) },
    })
    expect(off.status).toBe(409)
  })

  test('OD-I10: bulk edit with delta_minutes and on_deck_day is a 400', async () => {
    const id = await make({ title: 'One', target_at: daysFromNow(1) })
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [id], changes: { on_deck_day: day(2) }, delta_minutes: 60 },
    })
    expect(res.status).toBe(400)
    expect((await getTask(id)).on_deck_day).toBeNull()
  })
})
