/**
 * The day roster over HTTP (2026-10-22; GET /api/reminders?handled=1,
 * src/core/tasks/segment-roster.ts): a Days segment of four, read once; one
 * decked, one targeted (Today), one done — the segment still holds all four,
 * three of them `considered` with `segment_left`, and the form without
 * `handled=1` (a native build's) is unchanged: the three are simply gone.
 *
 * The task-queue switch is on for the deck (off again after). User A,
 * America/Chicago. Clock-independent: the tasks are backdated a day (a Days
 * segment lists a task from the day after it was made), the deck is the
 * OpenTask tomorrow (`openTaskToday`: the server's day, not the calendar's,
 * which between midnight and the day start is a day ahead).
 */

import path from 'path'
import Database from 'better-sqlite3'
import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { addDays } from '@/lib/opentask-day'
import { apiFetch, openTaskToday, resetTestData, setTaskQueue } from './helpers'

const tomorrow = async () => addDays(await openTaskToday('America/Chicago'), 1)

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

function madeYesterday(ids: number[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'))
  try {
    const when = new Date(Date.now() - 26 * 3600 * 1000).toISOString()
    const stmt = db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(when, id)
  } finally {
    db.close()
  }
}

type Row = { id: number; segment_state: string; segment_left?: string }
async function daysRows(query: string): Promise<Row[]> {
  const json = (await (await apiFetch(`/api/reminders${query}`)).json()) as {
    data: { task_segments: { horizon: string; tasks: Row[] }[] }
  }
  return json.data.task_segments.find((s) => s.horizon === 'days')?.tasks ?? []
}

describe('The day roster over HTTP', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })
  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('TQ-RI01: decked, targeted and done rows stay in the segment, handled', async () => {
    const ids = []
    for (const title of ['Deck me', 'Target me', 'Do me', 'Leave me']) {
      ids.push(await make({ title, horizon: 'days' }))
    }
    madeYesterday(ids)
    const [decked, targeted, done, left] = ids
    expect((await daysRows('?queue=1&deck=1&handled=1')).map((r) => r.id).sort()).toEqual(
      [...ids].sort(),
    )

    const d = await apiFetch('/api/tasks/deck', {
      method: 'POST',
      body: { ids: [decked], day: await tomorrow() },
    })
    expect(d.status).toBe(200)
    const t = await apiFetch('/api/task-segments/target-today', {
      method: 'POST',
      body: { ids: [targeted] },
    })
    expect(t.status).toBe(200)
    expect((await apiFetch(`/api/tasks/${done}/done`, { method: 'POST' })).status).toBe(200)

    const rows = await daysRows('?queue=1&deck=1&handled=1')
    const byId = Object.fromEntries(rows.map((r) => [r.id, [r.segment_state, r.segment_left]]))
    expect(byId).toEqual({
      [decked]: ['considered', 'deck'],
      [targeted]: ['considered', 'target'],
      [done]: ['considered', 'done'],
      [left]: ['waiting', undefined],
    })

    // The native form: no roster, no `segment_left` — the three are gone.
    const plain = await daysRows('?queue=1&deck=1')
    expect(plain.map((r) => r.id)).toEqual([left])
    expect(plain[0]).not.toHaveProperty('segment_left')
  })
})
