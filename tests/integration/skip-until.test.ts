/**
 * POST /api/tasks/bulk/skip-until (task queue PR 4): validation, a mixed
 * batch, the summary, and one Undo for the batch.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

// User A's timezone (scripts/seed-test.ts).
const TZ = 'America/Chicago'

/** Local 9:00 `days` from today, as UTC ISO. */
function nineAm(days: number): string {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function day(days: number): string {
  return DateTime.now().setZone(TZ).plus({ days }).toFormat('yyyy-MM-dd')
}

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body: { title: 'Task', ...body } })
  expect(res.status).toBe(201)
  return (await res.json()).data.id as number
}

async function get(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

function skip(body: Record<string, unknown>) {
  return apiFetch('/api/tasks/bulk/skip-until', { method: 'POST', body })
}

describe('POST /api/tasks/bulk/skip-until', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('a date skips every occurrence before it; one-offs are counted, not refused', async () => {
    const daily = await make({
      title: 'Water plants',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      due_at: nineAm(1),
    })
    const oneOff = await make({ due_at: nineAm(1) })

    const res = await skip({ ids: [daily, oneOff], until: day(5) })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(1)
    // Days 1, 2, 3, 4.
    expect(data.occurrences_skipped).toBe(4)
    expect(data.skipped_not_repeating).toBe(1)
    expect(data.already_clear).toBe(0)
    expect(data.task_ids).toEqual([daily])
    expect(data.summary).toMatch(
      /^Skipped 4 occurrences of "Water plants" · next .+ · 1 not repeating$/,
    )

    const after = await get(daily)
    expect(after.target_at).toBe(nineAm(5))
    expect(after.skip_count).toBe(4)
    expect((await get(oneOff)).target_at).toBe(nineAm(1))
  })

  test('no date skips this occurrence; Undo reverses the whole batch', async () => {
    const a = await make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: nineAm(1) })
    const b = await make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: nineAm(2) })
    const res = await skip({ ids: [a, b] })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(2)
    expect(data.occurrences_skipped).toBe(2)
    expect(data.summary).toBe('Skipped 2 tasks')
    expect((await get(a)).target_at).toBe(nineAm(2))
    expect((await get(b)).target_at).toBe(nineAm(3))

    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    expect((await undo.json()).data.undone_action).toBe('bulk_skip')
    expect((await get(a)).target_at).toBe(nineAm(1))
    expect((await get(b)).target_at).toBe(nineAm(2))
  })

  test('validation: the date format, a past day, empty ids, another user’s task', async () => {
    const t = await make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: nineAm(1) })
    expect((await skip({ ids: [t], until: 'next week' })).status).toBe(400)
    expect((await skip({ ids: [t], until: day(-1) })).status).toBe(400)
    // Today too: "skip this occurrence" is the no-date call.
    const today = await skip({ ids: [t], until: day(0) })
    expect(today.status).toBe(400)
    expect((await today.json()).error).toMatch(/tomorrow or later/)
    expect((await skip({ ids: [] })).status).toBe(400)
    expect((await skip({ ids: [t], until: '2026-02-30' })).status).toBe(400)
    // User B cannot skip user A's task.
    const res = await apiFetchB('/api/tasks/bulk/skip-until', {
      method: 'POST',
      body: { ids: [t] },
    })
    expect(res.status).toBe(400)
    expect((await get(t)).skip_count ?? 0).toBe(0)
  })

  test('an occurrence already past the date is left alone and said so', async () => {
    const monthlyLater = await make({
      rrule: 'FREQ=DAILY;INTERVAL=30;BYHOUR=9;BYMINUTE=0',
      due_at: nineAm(20),
    })
    const res = await skip({ ids: [monthlyLater], until: day(3) })
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(0)
    expect(data.already_clear).toBe(1)
    expect(data.summary).toMatch(/^Nothing skipped · 1 already on or after /)
    expect((await get(monthlyLater)).target_at).toBe(nineAm(20))
  })
})
