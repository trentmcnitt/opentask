/**
 * REPEAT ENDS over HTTP (2026-10-22; docs/TASK-MODEL.md § Repeat ends):
 * `repeat_count` / `repeat_until` on POST and PATCH (and COUNT / UNTIL as
 * shorthand in `rrule`), the 400s, and the writers' responses — `/done` and
 * `/undone` (the native DONE row), `skip-occurrence`, `bulk/skip-until`,
 * `bulk/complete` — each saying when it ended the series.
 *
 * Real clock: every task starts tomorrow or later (User A, America/Chicago).
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'

const TZ = 'America/Chicago'
const DAILY_9 = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

/** Local 9:00 `days` from today, as UTC ISO. */
function nineAm(days: number): string {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function day(days: number, format = 'yyyy-MM-dd'): string {
  return DateTime.now().setZone(TZ).plus({ days }).toFormat(format)
}

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body: { title: 'Task', ...body } })
  expect(res.status).toBe(201)
  return (await res.json()).data.id as number
}

async function get(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

async function post(path: string, body: unknown = {}) {
  const res = await apiFetch(path, { method: 'POST', body })
  return { status: res.status, json: await res.json() }
}

async function patch(id: number, body: unknown) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  return { status: res.status, json: await res.json() }
}

describe('Repeat ends over HTTP', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST: the fields, the derived fields, and the shorthand lifted', async () => {
    const counted = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 3 })
    expect(await get(counted)).toMatchObject({
      rrule: DAILY_9,
      repeat_count: 3,
      repeat_count_used: 0,
      repeat_until: null,
      repeat_last: false,
      repeat_remaining: 3,
    })
    // The legacy picker's form: UNTIL=YYYYMMDDT235959Z, the date taken literally.
    const dated = await make({
      rrule: `${DAILY_9};UNTIL=${day(10, 'yyyyMMdd')}T235959Z`,
      due_at: nineAm(1),
    })
    expect(await get(dated)).toMatchObject({
      rrule: DAILY_9,
      repeat_until: day(10),
      repeat_count: null,
      repeat_remaining: null,
    })
    const shorthand = await make({ rrule: `${DAILY_9};COUNT=6`, due_at: nineAm(1) })
    expect(await get(shorthand)).toMatchObject({ rrule: DAILY_9, repeat_count: 6 })
    // No end: the keys are there, empty.
    const plain = await make({ rrule: DAILY_9, due_at: nineAm(1) })
    expect(await get(plain)).toMatchObject({
      repeat_count: null,
      repeat_until: null,
      repeat_count_used: 0,
      repeat_last: false,
      repeat_remaining: null,
    })
  })

  test('PATCH: set, switch, keep across a rule change, clear with rrule null', async () => {
    const id = await make({ rrule: DAILY_9, due_at: nineAm(1) })
    expect((await patch(id, { repeat_count: 4 })).status).toBe(200)
    expect(await get(id)).toMatchObject({ repeat_count: 4, repeat_count_used: 0 })
    expect((await patch(id, { repeat_until: day(20) })).status).toBe(200)
    expect(await get(id)).toMatchObject({ repeat_count: null, repeat_until: day(20) })
    // A rule sent without an end leaves the end alone.
    expect((await patch(id, { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' })).status).toBe(200)
    expect((await get(id)).repeat_until).toBe(day(20))
    // Shorthand on PATCH.
    expect((await patch(id, { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0;COUNT=2' })).status).toBe(200)
    expect(await get(id)).toMatchObject({ repeat_count: 2, repeat_until: null })
    expect((await patch(id, { rrule: null })).status).toBe(200)
    expect(await get(id)).toMatchObject({ rrule: null, repeat_count: null, repeat_until: null })
  })

  test('the 400s', async () => {
    const refused = async (body: Record<string, unknown>, text: string) => {
      const res = await apiFetch('/api/tasks', { method: 'POST', body: { title: 'T', ...body } })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(JSON.stringify(await res.json())).toContain(text)
    }
    await refused({ rrule: DAILY_9, repeat_count: 0 }, 'from 1 to 999')
    await refused({ rrule: DAILY_9, repeat_count: 2, repeat_until: day(5) }, 'not both')
    await refused({ rrule: `${DAILY_9};COUNT=2;UNTIL=${day(5, 'yyyyMMdd')}` }, 'not both')
    await refused({ rrule: DAILY_9, repeat_until: day(-1) }, 'in the past')
    await refused({ rrule: DAILY_9, repeat_until: day(4000) }, 'years ahead')
    await refused(
      { rrule: DAILY_9, due_at: nineAm(5), repeat_until: day(2) },
      'before the current occurrence',
    )
    await refused({ repeat_count: 2 }, 'needs a repeat')
    await refused({ rrule: DAILY_9, is_reminder: true, repeat_count: 2 }, 'ordinary repeating task')

    const id = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 3 })
    await post(`/api/tasks/${id}/done`)
    const spent = await patch(id, { repeat_count: 1 })
    expect(spent.status).toBe(400)
    expect(JSON.stringify(spent.json)).toContain('repeat_count_used')

    // Ends are set per task.
    for (const changes of [{ repeat_count: 3 }, { rrule: `${DAILY_9};COUNT=3` }]) {
      const res = await apiFetch('/api/tasks/bulk/edit', {
        method: 'POST',
        body: { ids: [id], changes },
      })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('set per task')
    }
  })

  test('/done says series_ended; /undone (the DONE row) reopens it', async () => {
    const id = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 2 })
    const first = await post(`/api/tasks/${id}/done`)
    expect(first.status).toBe(200)
    expect(first.json.data).toMatchObject({ was_recurring: true, series_ended: false })
    expect(first.json.data.task).toMatchObject({ repeat_last: true, repeat_remaining: 1 })
    const occurrence = first.json.data.task.occurrence_at

    const last = await post(`/api/tasks/${id}/done`)
    expect(last.json.data).toMatchObject({ series_ended: true, next_due_at: null })
    expect(last.json.data.task).toMatchObject({
      done: true,
      repeat_count_used: 2,
      repeat_remaining: 0,
      repeat_last: false,
      occurrence_at: occurrence,
    })
    // Done again: refused.
    expect((await post(`/api/tasks/${id}/done`)).status).toBe(400)

    const reopened = await post(`/api/tasks/${id}/undone`)
    expect(reopened.status).toBe(200)
    expect(await get(id)).toMatchObject({
      done: false,
      archived_at: null,
      repeat_count_used: 1,
      repeat_last: true,
      occurrence_at: occurrence,
    })
  })

  test('skip-occurrence on the last: archived, never done; then refused', async () => {
    const id = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 1 })
    const res = await post(`/api/tasks/${id}/skip-occurrence`)
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      series_ended: true,
      done: false,
      skip_count: 1,
      repeat_count_used: 1,
      description: 'Skipped "Task" — the last of 1; the repeat has ended',
    })
    expect(res.json.data.archived_at).not.toBeNull()
    expect((await post(`/api/tasks/${id}/skip-occurrence`)).status).toBe(400)
    // Undo brings it back.
    expect((await post('/api/undo')).status).toBe(200)
    expect(await get(id)).toMatchObject({ archived_at: null, repeat_count_used: 0 })
  })

  test('bulk/skip-until past the end counts series_ended; bulk/complete counts series_ended_count', async () => {
    const counted = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 3 })
    const plain = await make({ rrule: DAILY_9, due_at: nineAm(1) })
    const res = await post('/api/tasks/bulk/skip-until', { ids: [counted, plain], until: day(10) })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      tasks_affected: 2,
      series_ended: 1,
      // 3 left of the count; days 1..9 of the plain one.
      occurrences_skipped: 3 + 9,
    })
    expect(res.json.data.summary).toContain('1 ended')

    const last = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 1 })
    const other = await make({ rrule: DAILY_9, due_at: nineAm(1), repeat_count: 5 })
    const done = await post('/api/tasks/bulk/complete', { ids: [last, other] })
    expect(done.status).toBe(200)
    expect(done.json.data).toMatchObject({ recurring_count: 2, series_ended_count: 1 })
    expect((await get(last)).done).toBe(true)
    expect(await get(other)).toMatchObject({ done: false, repeat_count_used: 1 })
  })
})
