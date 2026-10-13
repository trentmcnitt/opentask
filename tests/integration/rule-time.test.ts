/**
 * Every repeating task or reminder has a time of day (Trent, 2026-10-12), over
 * HTTP: a non-quota rule sent without BYHOUR is stored with the time of a date
 * sent with it, else the task's anchor, else its date's time, else the user's
 * Morning time setting. Quotas keep their bare period rule. Bare weekly and
 * monthly rules are still refused on a task (validation is unchanged).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

type Data = Record<string, unknown> & { id: number; rrule: string | null; anchor_time: string }

async function json(res: Response) {
  return (await res.json()) as { data: Data; error?: string }
}

async function create(body: Record<string, unknown>): Promise<Data> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await json(res)).data
}

async function patch(id: number, body: Record<string, unknown>): Promise<Data> {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  expect(res.status).toBe(200)
  return (await json(res)).data
}

async function setMorning(time: string) {
  const res = await apiFetch('/api/user/preferences', {
    method: 'PATCH',
    body: { morning_time: time },
  })
  expect(res.status).toBe(200)
}

describe('Every non-quota rule has a time (HTTP)', () => {
  let morningBefore = '09:00'

  beforeAll(async () => {
    await resetTestData()
    const prefs = await json(await apiFetch('/api/user/preferences'))
    morningBefore = String(prefs.data.morning_time)
    await setMorning('08:30')
  })

  afterAll(async () => {
    await setMorning(morningBefore)
  })

  test('POST — a timeless rule gets the Morning time setting', async () => {
    const t = await create({ title: 'rt daily', rrule: 'FREQ=DAILY' })
    expect(t.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
    expect(t.anchor_time).toBe('08:30')
  })

  test('POST — a changed Morning setting is honoured on the next new rule', async () => {
    await setMorning('07:15')
    const t = await create({ title: 'rt daily early', rrule: 'FREQ=DAILY;INTERVAL=2' })
    expect(t.rrule).toBe('FREQ=DAILY;INTERVAL=2;BYHOUR=7;BYMINUTE=15')
    await setMorning('08:30')
  })

  test('POST — a reminder sent a timeless rule gets one too', async () => {
    const r = await create({ title: 'rt reminder', is_reminder: true, rrule: 'FREQ=DAILY' })
    expect(r.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  })

  test('POST — a quota keeps its bare period rule', async () => {
    const q = await create({ title: 'rt quota', rrule: 'FREQ=WEEKLY', progress_target: 3 })
    expect(q.rrule).toBe('FREQ=WEEKLY')
    expect(q.anchor_time).toBeNull()
  })

  test('POST — a bare weekly rule on a task is still refused', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'rt bare weekly', rrule: 'FREQ=WEEKLY' },
    })
    expect(res.status).toBe(400)
  })

  test('PATCH — a new timeless rule keeps the task anchor (10:00), not Morning', async () => {
    const t = await create({ title: 'rt anchored', rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' })
    const after = await patch(t.id, { rrule: 'FREQ=WEEKLY;BYDAY=MO,TH' })
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=10;BYMINUTE=0')
    expect(after.anchor_time).toBe('10:00')
  })

  test('PATCH — an undated one-off made repeating gets Morning time', async () => {
    const t = await create({ title: 'rt one-off' })
    const after = await patch(t.id, { rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' })
    expect(after.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=8;BYMINUTE=30')
  })

  test('PATCH — re-sending the stored rule without its time changes nothing', async () => {
    const t = await create({ title: 'rt resend', rrule: 'FREQ=DAILY' })
    const res = await apiFetch(`/api/tasks/${t.id}`, {
      method: 'PATCH',
      body: { rrule: 'FREQ=DAILY' },
    })
    const body = (await res.json()) as { data: { fields_changed: string[]; rrule: string } }
    expect(body.data.fields_changed).toEqual([])
    expect(body.data.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  })

  test('PATCH — a task turned into a quota in the same request keeps the bare rule', async () => {
    const t = await create({ title: 'rt to quota' })
    const after = await patch(t.id, { rrule: 'FREQ=WEEKLY', progress_target: 4 })
    expect(after.rrule).toBe('FREQ=WEEKLY')
  })

  test('bulk edit — every task gets its own time', async () => {
    const a = await create({ title: 'rt bulk a', rrule: 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0' })
    const b = await create({ title: 'rt bulk b' })
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [a.id, b.id], changes: { rrule: 'FREQ=WEEKLY;BYDAY=SA' } },
    })
    expect(res.status).toBe(200)
    const readA = await json(await apiFetch(`/api/tasks/${a.id}`))
    const readB = await json(await apiFetch(`/api/tasks/${b.id}`))
    expect(readA.data.rrule).toBe('FREQ=WEEKLY;BYDAY=SA;BYHOUR=18;BYMINUTE=0')
    expect(readB.data.rrule).toBe('FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=30')
  })
})
