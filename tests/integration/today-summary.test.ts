/**
 * GET /api/tasks/today-summary (2026-10-30, Today's all-clear card): an
 * overdue task done counts as done; one moved onto tomorrow counts as moved.
 * The counts' rules are pinned in `tests/behavioral/dv-today-summary.test.ts`.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { DateTime } from 'luxon'
import { addDays } from '@/lib/opentask-day'
import { apiFetch, baseUrl, openTaskToday, resetTestData } from './helpers'

const TZ = 'America/Chicago'

const summary = async () => {
  const res = await apiFetch('/api/tasks/today-summary')
  expect(res.status).toBe(200)
  return (await res.json()).data as { done: number; moved: number }
}

async function create(title: string, dueAt: string): Promise<number> {
  const res = await apiFetch('/api/tasks', {
    method: 'POST',
    body: { title, due_at: dueAt },
  })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

describe('Today summary', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('a done overdue task and one moved to tomorrow are counted', async () => {
    const before = await summary()
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const done = await create('TS done', hourAgo)
    const moved = await create('TS moved', hourAgo)
    expect((await apiFetch(`/api/tasks/${done}/done`, { method: 'POST' })).status).toBe(200)
    // Tomorrow, mid-day: the OpenTask day after the server's today.
    const day = addDays(await openTaskToday(TZ), 1)
    const tomorrow = DateTime.fromISO(`${day}T12:00`, { zone: TZ }).toUTC().toISO()!
    const res = await apiFetch(`/api/tasks/${moved}`, {
      method: 'PATCH',
      body: { due_at: tomorrow },
    })
    expect(res.status).toBe(200)
    const after = await summary()
    expect(after.done).toBe(before.done + 1)
    expect(after.moved).toBe(before.moved + 1)
  })

  test('without a token: 401', async () => {
    const res = await fetch(`${baseUrl()}/api/tasks/today-summary`)
    expect(res.status).toBe(401)
  })
})
