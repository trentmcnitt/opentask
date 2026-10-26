/**
 * Task queue PR 1 over HTTP: `source`, and the additive response fields
 * (`queued`, `queued_name`, `capped_occurrence`, `snoozed_high_name`,
 * `summary`) on POST /api/tasks/bulk/snooze and /bulk/snooze-overdue.
 *
 * The server runs with OPENTASK_TASK_QUEUE off, as every other file expects;
 * this file turns it on through the test-only switch and off again after.
 *
 * Clock-independent: every task is over target by days, and every landing is
 * days ahead — always at or after the next rollover, whatever the hour.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { apiFetch, resetTestData, setTaskQueue } from './helpers'

const DAY = 24 * 3600 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()
/** A rollover time as the toast shows it ("6:30 AM"). */
const TIME = '\\d{1,2}:\\d\\d [AP]M'

/** Move every dated task of User A days ahead, so only this file's tasks are over target. */
async function clearOverTarget() {
  const tasks = (await (await apiFetch('/api/tasks?limit=300')).json()).data.tasks as {
    id: number
    due_at: string | null
    is_reminder: boolean
  }[]
  for (const t of tasks) {
    if (t.due_at && !t.is_reminder) {
      await apiFetch(`/api/tasks/${t.id}`, { method: 'PATCH', body: { due_at: daysFromNow(5) } })
    }
  }
}

async function make(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await apiFetch(path, { method: 'POST', body })
  return { status: res.status, json: await res.json() }
}

describe('Task queue: bulk snooze routes (switch on)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
    await clearOverTarget()
  })

  afterAll(async () => {
    await setTaskQueue(false)
  })

  test('TQ-I01: bulk/snooze rejects an unknown source', async () => {
    const id = await make({ title: 'Bad source', due_at: daysFromNow(-2) })
    const r = await post('/api/tasks/bulk/snooze', {
      ids: [id],
      until: daysFromNow(3),
      source: 'nope',
    })
    expect(r.status).toBe(400)
  })

  test('TQ-I02: a sweep on bulk/snooze marks the task, and the summary says so', async () => {
    const id = await make({ title: 'Call the bank', due_at: daysFromNow(-2) })
    const r = await post('/api/tasks/bulk/snooze', {
      ids: [id],
      until: daysFromNow(3),
      source: 'sweep',
    })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      tasks_affected: 1,
      queued: 1,
      queued_name: 'Call the bank',
      capped_occurrence: 0,
      snoozed_high_name: null,
    })
    // A queued task was moved too: its id is in `moved_ids` (2026-10-26).
    expect(r.json.data.moved_ids).toEqual([id])
    expect(r.json.data.summary).toMatch(
      new RegExp(`^"Call the bank" will move to the Tasks queue at ${TIME}$`),
    )
    const task = await getTask(id)
    expect(task).toMatchObject({ queue_mark: true, try_tomorrow: false, queued_at: null })
    // `queued_until` is the marked task's own target (the rollover).
    expect(r.json.data.queued_until).toBe(task.due_at)
    // The target is the next rollover, never the requested landing.
    expect(Date.parse(task.due_at)).toBeLessThan(Date.parse(daysFromNow(3)))
  })

  test('TQ-I03: a pick (no source) is never marked; one task is named', async () => {
    const id = await make({ title: 'Water the plants', due_at: daysFromNow(-2) })
    const until = daysFromNow(3)
    const r = await post('/api/tasks/bulk/snooze', { ids: [id], until, include_task_ids: [id] })
    expect(r.json.data).toMatchObject({ queued: 0, summary: 'Deferred "Water the plants"' })
    expect((await getTask(id)).due_at).toBe(until)
  })

  test('TQ-I04: Try Tomorrow needs no until', async () => {
    const id = await make({ title: 'Try me', priority: 1, due_at: daysFromNow(-2) })
    const r = await post('/api/tasks/bulk/snooze', { ids: [id], source: 'try_tomorrow' })
    expect(r.status).toBe(200)
    expect(r.json.data.queued).toBe(1)
    expect(await getTask(id)).toMatchObject({ queue_mark: true, try_tomorrow: true })
  })

  test('TQ-I05: snooze-overdue is a sweep; message equals summary', async () => {
    const id = await make({ title: 'Renew the card', due_at: daysFromNow(-2) })
    const high = await make({ title: 'High one', priority: 3, due_at: daysFromNow(-2) })
    const r = await post('/api/tasks/bulk/snooze-overdue', { until: daysFromNow(3) })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      tasks_affected: 1,
      queued: 1,
      queued_name: 'Renew the card',
      skipped_high: 1,
      snoozed_high_name: null,
    })
    expect(r.json.data.summary).toMatch(
      new RegExp(`^"Renew the card" will move to the Tasks queue at ${TIME} \\(1 high skipped\\)$`),
    )
    expect(r.json.data.message).toBe(r.json.data.summary)
    expect((await getTask(id)).queue_mark).toBe(true)
    // Only what moved (the queued one); the skipped High is not in it.
    expect(r.json.data.moved_ids).toEqual([id])
    expect(r.json.data.moved_ids).not.toContain(high)
  })

  test('TQ-I06: snooze-overdue moves ONE High per press, oldest first, and names it', async () => {
    await make({ title: 'Newer High', priority: 3, due_at: daysFromNow(-1) })
    await make({ title: 'Older High', priority: 3, due_at: daysFromNow(-3) })
    const first = await post('/api/tasks/bulk/snooze-overdue', { until: daysFromNow(3) })
    expect(first.json.data).toMatchObject({
      tasks_affected: 1,
      snoozed_high: 1,
      skipped_high: 1,
      snoozed_high_name: 'Older High',
      summary: 'Deferred high-priority "Older High" (1 high skipped)',
    })
    const second = await post('/api/tasks/bulk/snooze-overdue', { until: daysFromNow(3) })
    expect(second.json.data).toMatchObject({ snoozed_high_name: 'Newer High', skipped_high: 0 })
  })
})

describe('Task queue: bulk snooze routes (switch off)', () => {
  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(false)
    await clearOverTarget()
  })

  test('TQ-I10: the new fields are there, zero / null; summary and message are the old line', async () => {
    const a = await make({ title: 'A', due_at: daysFromNow(-2) })
    const until = daysFromNow(3)
    const r = await post('/api/tasks/bulk/snooze-overdue', { until })
    expect(r.json.data).toMatchObject({
      tasks_affected: 1,
      queued: 0,
      queued_name: null,
      capped_occurrence: 0,
      snoozed_high_name: null,
      queued_until: null,
      summary: 'Deferred 1 task',
      message: 'Deferred 1 task',
    })
    expect(await getTask(a)).toMatchObject({ due_at: until, queue_mark: false })
    expect(r.json.data.moved_ids).toEqual([a])
  })

  test('TQ-I10b: moved_ids is [] when nothing moves, on both routes', async () => {
    const empty = await post('/api/tasks/bulk/snooze-overdue', { until: daysFromNow(3) })
    expect(empty.json.data).toMatchObject({ tasks_affected: 0, moved_ids: [] })
    const urgent = await make({ title: 'Urgent', priority: 4, due_at: daysFromNow(-2) })
    const skipped = await post('/api/tasks/bulk/snooze', { ids: [urgent], until: daysFromNow(3) })
    expect(skipped.json.data).toMatchObject({ tasks_affected: 0, moved_ids: [] })
  })

  test('TQ-I11: a sweep source on bulk/snooze changes nothing with the switch off', async () => {
    const a = await make({ title: 'A', due_at: daysFromNow(-2) })
    const until = daysFromNow(3)
    const r = await post('/api/tasks/bulk/snooze', { ids: [a], until, source: 'sweep' })
    expect(r.json.data).toMatchObject({ tasks_affected: 1, queued: 0, summary: 'Deferred 1 task' })
    expect(await getTask(a)).toMatchObject({ due_at: until, queue_mark: false })
  })
})
