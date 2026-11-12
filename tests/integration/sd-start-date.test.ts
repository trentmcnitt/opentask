/**
 * The start date over HTTP (2026-11-12; docs/TASK-MODEL.md § Start date,
 * rules START-1, START-2, START-7, START-9): `start_date` on create, PATCH
 * and bulk edit, the 400s, and the fields a caller reads back
 * (`deadline_window`, `next_round`, the Due row's `window`). The day-by-day
 * rules are pinned in tests/behavioral/sd-start-date.test.ts.
 *
 * Task queue on. Every day is the server's OpenTask day (`openTaskToday`),
 * never the calendar's.
 */
import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { addDays } from '@/lib/opentask-day'
import { apiFetch, openTaskToday, resetTestData, setTaskQueue } from './helpers'

const TZ = 'America/Chicago' // user A (scripts/seed-test.ts)
let today = ''
const day = (n: number) => addDays(today, n)
/** 23:00 local on the OpenTask day `n` days out: a deadline on that day. */
const deadlineOn = (n: number) =>
  DateTime.fromISO(`${day(n)}T23:00`, { zone: TZ })
    .toUTC()
    .toISO()!

async function post(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  return { status: res.status, json: await res.json() }
}
async function patch(id: number, body: Record<string, unknown>) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  return { status: res.status, json: await res.json() }
}
async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

describe('The start date over HTTP', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
    today = await openTaskToday(TZ)
  })
  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('create with a start date: stored, and the task reports its stage', async () => {
    const future = await post({
      title: 'Synthetic fern voucher',
      horizon: 'weeks',
      deadline_at: deadlineOn(60),
      start_date: day(20),
    })
    expect(future.status).toBe(201)
    expect(future.json.data).toMatchObject({
      start_date: day(20),
      lead_from: day(20),
      lead_days: null,
      target_at: null,
      deadline_window: 'before_start',
      next_round: null,
    })
    const started = await post({
      title: 'Synthetic moss permit',
      horizon: 'weeks',
      deadline_at: deadlineOn(60),
      start_date: today,
    })
    expect(started.json.data.deadline_window).toBe('open')
    expect(started.json.data.next_round).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(started.json.data.next_round > day(6)).toBe(true) // a full week on, at least

    const rem = await (await apiFetch('/api/reminders?queue=1&deck=1&deadlines=1')).json()
    const page = rem.data.task_segments.find((s: { horizon: string }) => s.horizon === 'deadlines')
    const rows = page.tasks.map((t: { id: number; window: string; segment_state: string }) => [
      t.id,
      t.window,
      t.segment_state,
    ])
    expect(rows).toEqual([[started.json.data.id, 'open', 'waiting']])
  })

  test('the 400s: inside the safety net, no deadline, a repeat, and both choices at once', async () => {
    const base = { title: 'Synthetic fern voucher', deadline_at: deadlineOn(30) }
    expect((await post({ ...base, start_date: day(29) })).status).toBe(400)
    expect((await post({ ...base, start_date: day(30) })).status).toBe(400)
    expect((await post({ ...base, start_date: day(28) })).status).toBe(201)
    expect((await post({ title: 'Synthetic no deadline', start_date: day(5) })).status).toBe(400)
    expect((await post({ ...base, start_date: day(5), lead_days: 3 })).status).toBe(400)
    expect((await post({ ...base, start_date: '2027-02-30' })).status).toBe(400)
    expect((await post({ ...base, start_date: 'soon' })).status).toBe(400)
    const repeat = await post({
      ...base,
      rrule: 'FREQ=DAILY;INTERVAL=30;BYHOUR=23;BYMINUTE=0',
      start_date: day(5),
    })
    expect(repeat.status).toBe(400)
  })

  test('PATCH: one choice with lead_days; a deadline move into the net clears it; undo restores', async () => {
    const made = await post({
      title: 'Synthetic fern voucher',
      deadline_at: deadlineOn(60),
      lead_days: 12,
    })
    const id = made.json.data.id
    const dated = await patch(id, { start_date: day(10) })
    expect(dated.status).toBe(200)
    expect(dated.json.data).toMatchObject({ start_date: day(10), lead_days: null })
    expect(dated.json.data.fields_changed).toEqual(
      expect.arrayContaining(['start_date', 'lead_days', 'lead_from']),
    )
    expect((await patch(id, { start_date: day(12), lead_days: 4 })).status).toBe(400)
    const days = await patch(id, { lead_days: 12 })
    expect(days.json.data).toMatchObject({ start_date: null, lead_days: 12, lead_from: day(48) })

    await patch(id, { start_date: day(10) })
    // The deadline moves to the day after the start: the start is inside the net.
    const moved = await patch(id, { deadline_at: deadlineOn(11) })
    expect(moved.json.data).toMatchObject({ start_date: null, lead_days: null })
    const undone = await apiFetch('/api/undo', { method: 'POST', body: {} })
    expect(undone.status).toBe(200)
    expect(await getTask(id)).toMatchObject({ start_date: day(10), lead_from: day(10) })
  })

  test('bulk edit takes start_date; Defer on an open-window row moves it', async () => {
    const a = (await post({ title: 'Synthetic fern voucher', deadline_at: deadlineOn(60) })).json
      .data.id
    const b = (await post({ title: 'Synthetic moss permit', deadline_at: deadlineOn(70) })).json
      .data.id
    const bulk = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [a, b], changes: { start_date: today } },
    })
    expect(bulk.status).toBe(200)
    expect(await getTask(a)).toMatchObject({ start_date: today, deadline_window: 'open' })
    expect(await getTask(b)).toMatchObject({ start_date: today, deadline_window: 'open' })

    const defer = await apiFetch('/api/task-segments/defer-lead', {
      method: 'POST',
      body: { ids: [a] },
    })
    expect(defer.status).toBe(200)
    expect(await getTask(a)).toMatchObject({
      start_date: day(1),
      lead_from: day(1),
      deadline_window: 'before_start',
    })
  })

  test('with the task queue off the date is stored and nothing reads it', async () => {
    await setTaskQueue(false)
    today = await openTaskToday(TZ)
    const made = await post({
      title: 'Synthetic fern voucher',
      deadline_at: deadlineOn(60),
      start_date: day(10),
    })
    expect(made.status).toBe(201)
    expect(made.json.data).toMatchObject({ start_date: day(10), deadline_window: null })
  })
})
