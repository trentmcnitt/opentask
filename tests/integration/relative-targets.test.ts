/**
 * RELATIVE TARGETS over HTTP (2026-10-24; docs/TASK-MODEL.md § Relative
 * targets): POST / PATCH / bulk edit with `target_days_before`, `target_time`
 * and `target_slot_id` on a one-off with a deadline, the 400s, a snooze that
 * makes it fixed, undo, and the period PATCH / DELETE that carry linked
 * targets (`targets_moved`, `targets_kept`, `targets_converted`). Test user
 * A's clock is America/Chicago (default periods: Evening 20:30); every date
 * is relative to now.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

const TZ = 'America/Chicago'

type Body = { data: Record<string, unknown> & { id: number }; error?: string }

async function send(path: string, method: string, body?: unknown) {
  const res = await apiFetch(path, { method, body })
  return { status: res.status, body: (await res.json()) as Body }
}

/** `days` local days from today at HH:MM, Chicago. */
function local(days: number, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number)
  return DateTime.now().setZone(TZ).plus({ days }).set({ hour, minute, second: 0, millisecond: 0 })
}
const iso = (d: DateTime) => d.toUTC().toISO()!
const same = (a: unknown, b: DateTime) => expect(Date.parse(a as string)).toBe(b.toMillis())

type Slot = { id: number; label: string; start_time: string }
async function slots(fetcher = apiFetch): Promise<Slot[]> {
  const res = await fetcher('/api/time-slots')
  return ((await res.json()) as { data: { time_slots: Slot[] } }).data.time_slots
}
async function evening(): Promise<Slot> {
  return (await slots()).find((s) => s.label === 'Evening')!
}

/** A one-off due in 6 days at 08:30, target the day before at Evening. */
async function relative(extra: Record<string, unknown> = {}) {
  const r = await send('/api/tasks', 'POST', {
    title: 'rt one-off',
    deadline_at: iso(local(6, '08:30')),
    target_days_before: 1,
    target_slot_id: (await evening()).id,
    ...extra,
  })
  expect(r.status).toBe(201)
  return r.body.data
}

describe('Relative targets over HTTP', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST: linked to a period — derived, the time its start; GET returns the link', async () => {
    const t = await relative()
    expect(t).toMatchObject({
      target_days_before: 1,
      target_time: '20:30',
      target_slot_id: (await evening()).id,
      target_auto: false,
      repeat_anchor: null,
    })
    same(t.target_at, local(5, '20:30'))
    const got = await send(`/api/tasks/${t.id}`, 'GET')
    expect(got.body.data.target_slot_id).toBe((await evening()).id)
  })

  test('POST / PATCH 400s: no deadline, half a pair, target_at with offsets, a period not yours', async () => {
    const noDeadline = await send('/api/tasks', 'POST', {
      title: 'x',
      target_days_before: 1,
      target_time: '18:00',
    })
    expect(noDeadline.status).toBe(400)
    const half = await send('/api/tasks', 'POST', {
      title: 'x',
      deadline_at: iso(local(6, '08:30')),
      target_days_before: 1,
    })
    expect(half.status).toBe(400)
    const t = await relative()
    const both = await send(`/api/tasks/${t.id}`, 'PATCH', {
      target_at: iso(local(2, '09:00')),
      target_days_before: 2,
      target_time: '09:00',
    })
    expect(both.status).toBe(400)
    const theirs = (await slots(apiFetchB)).find((s) => s.label === 'Evening')!
    const notMine = await send(`/api/tasks/${t.id}`, 'PATCH', { target_slot_id: theirs.id })
    expect(notMine.status).toBe(400)
  })

  test('PATCH deadline_at: the target follows; PATCH target_at: fixed', async () => {
    const t = await relative()
    const moved = await send(`/api/tasks/${t.id}`, 'PATCH', {
      deadline_at: iso(local(8, '08:30')),
    })
    expect(moved.status).toBe(200)
    same(moved.body.data.target_at, local(7, '20:30'))
    const fixed = await send(`/api/tasks/${t.id}`, 'PATCH', { target_at: iso(local(3, '09:00')) })
    expect(fixed.body.data).toMatchObject({
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
    same(fixed.body.data.target_at, local(3, '09:00'))
  })

  test('the snooze endpoint makes it fixed; undo puts the relative target back', async () => {
    const t = await relative()
    const snoozed = await send(`/api/tasks/${t.id}/snooze`, 'POST', {
      until: iso(local(2, '09:00')),
    })
    expect(snoozed.status).toBe(200)
    const after = await send(`/api/tasks/${t.id}`, 'GET')
    expect(after.body.data).toMatchObject({ target_days_before: null, target_slot_id: null })
    expect((await send('/api/undo', 'POST')).status).toBe(200)
    const back = await send(`/api/tasks/${t.id}`, 'GET')
    expect(back.body.data).toMatchObject({
      target_days_before: 1,
      target_slot_id: (await evening()).id,
    })
    same(back.body.data.target_at, local(5, '20:30'))
  })

  test('bulk edit: offsets per task; one task with no deadline refuses the batch', async () => {
    const a = (
      await send('/api/tasks', 'POST', { title: 'a', deadline_at: iso(local(6, '08:30')) })
    ).body.data
    const b = (
      await send('/api/tasks', 'POST', { title: 'b', deadline_at: iso(local(9, '17:00')) })
    ).body.data
    const plain = (await send('/api/tasks', 'POST', { title: 'p' })).body.data
    const ok = await send('/api/tasks/bulk/edit', 'POST', {
      ids: [a.id, b.id],
      changes: { target_days_before: 2, target_time: '07:00' },
    })
    expect(ok.status).toBe(200)
    same((await send(`/api/tasks/${a.id}`, 'GET')).body.data.target_at, local(4, '07:00'))
    same((await send(`/api/tasks/${b.id}`, 'GET')).body.data.target_at, local(7, '07:00'))
    const refused = await send('/api/tasks/bulk/edit', 'POST', {
      ids: [a.id, plain.id],
      changes: { target_days_before: 1, target_time: '07:00' },
    })
    expect(refused.status).toBe(400)
  })

  test('the period PATCH carries linked targets; DELETE keeps their time', async () => {
    await resetTestData()
    const t = await relative()
    const slot = await evening()
    const retimed = await send(`/api/time-slots/${slot.id}`, 'PATCH', { start_time: '21:00' })
    expect(retimed.status).toBe(200)
    expect(retimed.body.data).toMatchObject({ targets_moved: 1, targets_kept: 0 })
    const after = (await send(`/api/tasks/${t.id}`, 'GET')).body.data
    expect(after).toMatchObject({ target_time: '21:00', target_slot_id: slot.id })
    same(after.target_at, local(5, '21:00'))

    const removed = await send(`/api/time-slots/${slot.id}`, 'DELETE')
    expect(removed.status).toBe(200)
    expect(removed.body.data).toMatchObject({ targets_converted: 1 })
    const kept = (await send(`/api/tasks/${t.id}`, 'GET')).body.data
    expect(kept).toMatchObject({ target_time: '21:00', target_slot_id: null })
    same(kept.target_at, local(5, '21:00'))
    // Undo the delete: the period and the link come back.
    expect((await send('/api/undo', 'POST')).status).toBe(200)
    expect((await send(`/api/tasks/${t.id}`, 'GET')).body.data.target_slot_id).toBe(slot.id)
  })
})
