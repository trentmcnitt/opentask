/**
 * DEADLINE-ANCHORED REPEATS over HTTP (2026-10-21; docs/TASK-MODEL.md
 * § Recurrence Model): the fields on POST / PATCH / bulk edit and every 400
 * (plan §3.2/§3.3), what a native client's capped move does, and that the
 * native completion endpoint derives the next occurrence's dates. Test user
 * A's clock is America/Chicago; every date is relative to now.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'

const TZ = 'America/Chicago'

type Body = { data: Record<string, unknown> & { id: number }; error?: string }

async function send(path: string, method: string, body?: unknown) {
  const res = await apiFetch(path, { method, body })
  return { status: res.status, body: (await res.json()) as Body }
}

/** A deadline three days out at 17:00 Chicago — on whatever weekday that is. */
function deadlineIn(days: number): DateTime {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days })
    .set({ hour: 17, minute: 0, second: 0, millisecond: 0 })
}
const iso = (d: DateTime) => d.toUTC().toISO()!
/** Weekly on the deadline's weekday (a bare FREQ=WEEKLY is a quota's period rule). */
const WEEKLY = `FREQ=WEEKLY;BYDAY=${['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][deadlineIn(3).weekday - 1]}`
const same = (a: unknown, b: DateTime) => expect(Date.parse(a as string)).toBe(b.toMillis())

/** A deadline-anchored weekly: deadline in 3 days at 17:00, target the day before at 18:00. */
async function weekly(extra: Record<string, unknown> = {}) {
  const r = await send('/api/tasks', 'POST', {
    title: 'ra weekly',
    rrule: WEEKLY,
    deadline_at: iso(deadlineIn(3)),
    target_days_before: 1,
    target_time: '18:00',
    ...extra,
  })
  expect(r.status).toBe(201)
  return r.body.data
}

describe('Deadline-anchored repeats over HTTP', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST: a rule with a deadline is deadline-anchored; the target is derived', async () => {
    const t = await weekly()
    expect(t.repeat_anchor).toBe('deadline')
    expect(t.target_days_before).toBe(1)
    expect(t.target_time).toBe('18:00')
    expect(t.rrule).toBe(`${WEEKLY};BYHOUR=17;BYMINUTE=0`)
    expect(t.deadline_at).toBe(t.occurrence_at)
    same(t.deadline_at, deadlineIn(3))
    same(t.target_at, deadlineIn(2).set({ hour: 18 }))
    // No offsets sent: the default (weekly — the day before, at the morning time).
    const d = await send('/api/tasks', 'POST', {
      title: 'ra default',
      rrule: WEEKLY,
      deadline_at: iso(deadlineIn(3)),
    })
    expect(d.status).toBe(201)
    expect(d.body.data.target_days_before).toBe(1)
    // A one-off says null; a plain repeat 'target'.
    const oneOff = await send('/api/tasks', 'POST', { title: 'ra one-off' })
    expect(oneOff.body.data.repeat_anchor).toBeNull()
    const plain = await send('/api/tasks', 'POST', { title: 'ra plain', rrule: 'FREQ=DAILY' })
    expect(plain.body.data.repeat_anchor).toBe('target')
    expect(plain.body.data.target_days_before).toBeNull()
  })

  test('POST: the 400s', async () => {
    const deadline = iso(deadlineIn(3))
    const cases: Record<string, unknown>[] = [
      { rrule: WEEKLY, deadline_at: deadline, repeat_anchor: 'target' },
      { rrule: WEEKLY, deadline_at: deadline, repeat_anchor: 'deadline', is_reminder: true },
      { deadline_at: deadline, repeat_anchor: 'deadline' },
      { rrule: WEEKLY, target_days_before: 1, target_time: '09:00' },
      { rrule: WEEKLY, deadline_at: deadline, target_days_before: 1 },
      { rrule: `${WEEKLY};BYHOUR=9;BYMINUTE=0`, deadline_at: deadline },
      { rrule: WEEKLY, deadline_at: deadline, target_days_before: 0, target_time: '18:00' },
      { rrule: WEEKLY, deadline_at: deadline, target_days_before: 7, target_time: '09:00' },
      { rrule: WEEKLY, deadline_at: deadline, target_days_before: 400, target_time: '09:00' },
      { rrule: WEEKLY, deadline_at: deadline, target_days_before: 1, target_time: '25:00' },
    ]
    for (const body of cases) {
      const r = await send('/api/tasks', 'POST', { title: 'ra bad', ...body })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
  })

  test('PATCH: a deadline reschedules this occurrence; new offsets re-derive; the 400s', async () => {
    const t = await weekly()
    const moved = await send(`/api/tasks/${t.id}`, 'PATCH', { deadline_at: iso(deadlineIn(4)) })
    expect(moved.status).toBe(200)
    same(moved.body.data.occurrence_at, deadlineIn(4))
    same(moved.body.data.target_at, deadlineIn(3).set({ hour: 18 }))
    const offsets = await send(`/api/tasks/${t.id}`, 'PATCH', {
      target_days_before: 2,
      target_time: '09:00',
    })
    same(offsets.body.data.target_at, deadlineIn(2).set({ hour: 9 }))
    const refused: Record<string, unknown>[] = [
      { deadline_at: null },
      { target_at: null },
      { repeat_anchor: 'target' },
      { target_days_before: 0, target_time: '18:00' },
      { target_days_before: 9 },
      { is_reminder: true, repeat_anchor: 'deadline' },
    ]
    for (const body of refused) {
      const r = await send(`/api/tasks/${t.id}`, 'PATCH', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    // A target-anchored repeat never gains a deadline; a rule on a one-off
    // with a deadline needs the anchor (A3).
    const plain = (await send('/api/tasks', 'POST', { title: 'ra p', rrule: 'FREQ=DAILY' })).body
    expect(
      (await send(`/api/tasks/${plain.data.id}`, 'PATCH', { deadline_at: iso(deadlineIn(3)) }))
        .status,
    ).toBe(400)
    const oneOff = (
      await send('/api/tasks', 'POST', { title: 'ra o', deadline_at: iso(deadlineIn(3)) })
    ).body
    const noAnchor = await send(`/api/tasks/${oneOff.data.id}`, 'PATCH', { rrule: WEEKLY })
    expect(noAnchor.status).toBe(400)
    const anchored = await send(`/api/tasks/${oneOff.data.id}`, 'PATCH', {
      rrule: WEEKLY,
      repeat_anchor: 'deadline',
    })
    expect(anchored.status).toBe(200)
    expect(anchored.body.data.repeat_anchor).toBe('deadline')
    same(anchored.body.data.occurrence_at, deadlineIn(3))
  })

  test("a native client's move past the deadline stops AT it", async () => {
    const t = await weekly()
    const r = await send(`/api/tasks/${t.id}`, 'PATCH', {
      due_at: iso(deadlineIn(5)),
      cap_at_deadline: true,
    })
    expect(r.status).toBe(200)
    expect(r.body.data.capped_at_deadline).toBe(true)
    expect(r.body.data.due_at).toBe(t.deadline_at)
    expect(r.body.data.occurrence_at).toBe(t.deadline_at)
  })

  test('bulk/complete advances to the next deadline and derives its target', async () => {
    const t = await weekly()
    const r = await send('/api/tasks/bulk/complete', 'POST', { ids: [t.id] })
    expect(r.status).toBe(200)
    const next = (await send(`/api/tasks/${t.id}`, 'GET')).body.data
    same(next.deadline_at, deadlineIn(10))
    expect(next.occurrence_at).toBe(next.deadline_at)
    same(next.target_at, deadlineIn(9).set({ hour: 18 }))
  })

  test('bulk edit: held to the same rules — a refusal refuses the batch', async () => {
    const a = await weekly()
    const plain = (await send('/api/tasks', 'POST', { title: 'ra b', rrule: 'FREQ=DAILY' })).body
    const bad = await send('/api/tasks/bulk/edit', 'POST', {
      ids: [a.id, plain.data.id],
      changes: { deadline_at: iso(deadlineIn(5)) },
    })
    expect(bad.status).toBe(400)
    const after = (await send(`/api/tasks/${a.id}`, 'GET')).body.data
    expect(after.deadline_at).toBe(a.deadline_at)
    const ok = await send('/api/tasks/bulk/edit', 'POST', {
      ids: [a.id],
      changes: { target_days_before: 2, target_time: '20:00' },
    })
    expect(ok.status).toBe(200)
    const edited = (await send(`/api/tasks/${a.id}`, 'GET')).body.data
    same(edited.target_at, deadlineIn(1).set({ hour: 20 }))
  })
})
