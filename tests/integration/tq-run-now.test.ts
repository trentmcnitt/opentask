/**
 * Task queue: "Roll over now" over HTTP (POST /api/rollover/run-now,
 * src/core/tasks/rollover-now.ts) — dry run, real run with its Undo, and the
 * switch off.
 *
 * The server runs with OPENTASK_TASK_QUEUE off, as every other file expects;
 * this file turns it on through the test-only switch and off again after.
 * Clock-independent: every target is days in the past or the future.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { apiAnon, apiFetch, apiFetchB, resetTestData, setTaskQueue } from './helpers'

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

async function runNow(dryRun = false) {
  const res = await apiFetch(`/api/rollover/run-now${dryRun ? '?dry_run=1' : ''}`, {
    method: 'POST',
  })
  return { status: res.status, json: await res.json() }
}

describe('Task queue: roll over now', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('TQ-I20: dry run counts and writes nothing; the real run strips; Undo puts it back', async () => {
    const plain = await make({ title: 'Call the bank', due_at: daysFromNow(-2) })
    const later = await make({ title: 'Later', due_at: daysFromNow(2) })
    const high = await make({ title: 'Pay rent', due_at: daysFromNow(-2), priority: 3 })
    const target = (await getTask(plain)).due_at

    const dry = await runNow(true)
    expect(dry.status).toBe(200)
    expect(dry.json.data.dry_run).toBe(true)
    expect(dry.json.data.ids.stripped).toContain(plain)
    expect(dry.json.data.ids.stripped).not.toContain(later)
    expect(dry.json.data.ids.stripped).not.toContain(high)
    expect(dry.json.data.undo_id).toBeNull()
    expect((await getTask(plain)).due_at).toBe(target)

    const real = await runNow()
    expect(real.status).toBe(200)
    expect(real.json.data.stripped).toBe(dry.json.data.stripped)
    expect(real.json.data.undo_id).toEqual(expect.any(Number))
    const stripped = await getTask(plain)
    expect(stripped.due_at).toBeNull()
    expect(stripped.queued_at).not.toBeNull()
    expect((await getTask(later)).due_at).not.toBeNull()
    expect((await getTask(high)).due_at).not.toBeNull()

    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    const back = await getTask(plain)
    expect(back.due_at).toBe(target)
    expect(back.queued_at).toBeNull()
  })

  test('TQ-I21: switch off → 409, nothing changed', async () => {
    const plain = await make({ title: 'Call the bank', due_at: daysFromNow(-2) })
    await setTaskQueue(false)
    const r = await runNow()
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('CONFLICT')
    expect((await getTask(plain)).due_at).not.toBeNull()
  })

  test("TQ-I23: only the caller's tasks: another user's past targets survive", async () => {
    const mine = await make({ title: 'Mine', due_at: daysFromNow(-2) })
    const res = await apiFetchB('/api/tasks', {
      method: 'POST',
      body: { title: 'Theirs', due_at: daysFromNow(-2) },
    })
    expect(res.status).toBe(201)
    const theirs = (await res.json()).data.id
    const before = (await (await apiFetchB(`/api/tasks/${theirs}`)).json()).data

    const r = await runNow()
    expect(r.status).toBe(200)
    expect(r.json.data.ids.stripped).toContain(mine)
    expect(r.json.data.ids.stripped).not.toContain(theirs)

    const after = (await (await apiFetchB(`/api/tasks/${theirs}`)).json()).data
    expect(after.due_at).toBe(before.due_at)
    expect(after.queued_at).toBeNull()
    expect(after.rolled_over_at).toBeNull()
  })

  test('TQ-I22: requires auth', async () => {
    const res = await apiAnon('/api/rollover/run-now', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
