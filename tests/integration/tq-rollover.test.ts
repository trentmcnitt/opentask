/**
 * Task queue PR 2 over HTTP: the test-only rollover trigger
 * (POST /api/test/rollover) end to end, and what a strip does to the
 * over-target count (GET /api/tasks/counts).
 *
 * The server runs with OPENTASK_TASK_QUEUE off, as every other file expects;
 * this file turns it on through the test-only switch and off again after.
 *
 * Clock-independent: the strip is run as of a day ahead (`now`), and every
 * task here is over target by days.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { apiFetch, resetTestData, setTaskQueue } from './helpers'

const DAY = 24 * 3600 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

async function overdue(): Promise<number> {
  return (await (await apiFetch('/api/tasks/counts')).json()).data.overdue
}

async function rollover(body: Record<string, unknown>) {
  const res = await apiFetch('/api/test/rollover', { method: 'POST', body })
  return { status: res.status, json: await res.json() }
}

describe('Task queue: the rollover (switch on)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('TQ-I10: rejects a bad now / user_id', async () => {
    expect((await rollover({ now: 'not a date' })).status).toBe(400)
    expect((await rollover({ user_id: 'one' })).status).toBe(400)
  })

  test('TQ-I11: first sight stamps only; a later day strips a one-off and the count drops', async () => {
    const plain = await make({ title: 'Call the bank', due_at: daysFromNow(-2) })
    const high = await make({ title: 'Pay rent', due_at: daysFromNow(-2), priority: 3 })
    const before = await overdue()

    // Today has been stamped already (deploy stamp or first sight): no strip.
    const first = await rollover({})
    expect(first.status).toBe(200)
    expect(first.json.data.stripped).toBe(0)
    expect((await getTask(plain)).due_at).not.toBeNull()

    // A day on: the OpenTask day has turned.
    const r = await rollover({ now: daysFromNow(1) })
    expect(r.status).toBe(200)
    expect(r.json.data.ran).toBeGreaterThanOrEqual(1)
    expect(r.json.data.stripped).toBeGreaterThanOrEqual(1)

    const stripped = await getTask(plain)
    expect(stripped.due_at).toBeNull()
    expect(stripped.target_at).toBeNull()
    expect(stripped.queued_at).not.toBeNull()
    expect(stripped.queued_from_due_at).not.toBeNull()
    expect(stripped.rolled_over_at).not.toBeNull()
    expect((await getTask(high)).due_at).not.toBeNull()

    expect(await overdue()).toBeLessThanOrEqual(before - 1)

    // Exactly once: again as of the same day does nothing.
    const again = await rollover({ now: daysFromNow(1) })
    expect(again.json.data.ran).toBe(0)
  })

  test('TQ-I12: switch off — the stamp moves, nothing is stripped', async () => {
    await setTaskQueue(false)
    const plain = await make({ title: 'Call the bank', due_at: daysFromNow(-2) })
    await rollover({})
    const r = await rollover({ now: daysFromNow(1) })
    expect(r.json.data.ran).toBe(0)
    expect((await getTask(plain)).due_at).not.toBeNull()
  })
})
