/**
 * EVERY-TIME MODE over HTTP (2026-10-22, editor plan §5, §14.1, §17 RT-5):
 * the patches `draftToPatch` builds (src/lib/every-time.ts) sent to the real
 * route — each one PATCH, one undo entry — and what the server does with a
 * repeat that ENDS. Test user A's clock is America/Chicago; every date is
 * relative to now.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'
import {
  draftFromTask,
  draftProblem,
  draftReducer,
  draftToPatch,
  type DraftAction,
  type EveryTimeContext,
  type EveryTimeTask,
} from '@/lib/every-time'

const TZ = 'America/Chicago'
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

type Row = EveryTimeTask & { id: number; target_at: string | null; target_auto: boolean }
type Body = { data: Row; error?: string }

async function send(path: string, method: string, body?: unknown) {
  const res = await apiFetch(path, { method, body })
  return { status: res.status, body: (await res.json()) as Body }
}

const ctx = (): EveryTimeContext => ({
  timezone: TZ,
  morningTime: '09:00',
  now: new Date(),
  // The test server's day: the task queue is off there, so midnight.
  dayStart: CALENDAR_DAY_START,
})
const iso = (d: DateTime) => d.toUTC().toISO()!
/** `days` from today at `hour`:00 Chicago. */
const day = (days: number, hour: number) =>
  DateTime.now().setZone(TZ).plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 })

/** The schedule fields an undo must put back exactly. */
const SCHEDULE = [
  'rrule',
  'recurrence_mode',
  'repeat_anchor',
  'target_days_before',
  'target_time',
  'due_at',
  'deadline_at',
  'occurrence_at',
  'anchor_time',
] as const
const schedule = (t: Row) => Object.fromEntries(SCHEDULE.map((k) => [k, t[k]]))

async function get(id: number): Promise<Row> {
  return (await send(`/api/tasks/${id}`, 'GET')).body.data
}

/** The task's draft after `actions`, checked valid, and its patch. */
function patchFor(task: Row, ...actions: DraftAction[]) {
  const c = ctx()
  const draft = actions.reduce(draftReducer, draftFromTask(task, c))
  expect(draft.refusal).toBeNull()
  expect(draftProblem(task, draft, c)).toBeNull()
  return draftToPatch(task, draft, c)
}

describe('Every-time mode over HTTP', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('RT-5: a rule that ends (COUNT / UNTIL) is lifted into the end fields on POST and PATCH', async () => {
    // Repeat ends (2026-10-22, docs/TASK-MODEL.md § Repeat ends): the
    // shorthand the picker and the draft send is accepted; the rule is stored
    // end-free and the end goes into `repeat_count` / `repeat_until`.
    const untilDay = day(10, 9)
    const until = untilDay.toFormat("yyyyLLdd'T'235959'Z'")
    const counted = await send('/api/tasks', 'POST', {
      title: 'ends',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3',
    })
    expect(counted.status).toBe(201)
    expect(await get(counted.body.data.id)).toMatchObject({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      repeat_count: 3,
      repeat_until: null,
    })
    const dated = await send('/api/tasks', 'POST', {
      title: 'ends',
      rrule: `FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=${until}`,
    })
    expect(dated.status).toBe(201)
    expect(await get(dated.body.data.id)).toMatchObject({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      repeat_until: untilDay.toFormat('yyyy-MM-dd'),
    })
    const t = await send('/api/tasks', 'POST', {
      title: 'et ends',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    })
    expect(t.status).toBe(201)
    const patch = await send(`/api/tasks/${t.body.data.id}`, 'PATCH', {
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3',
    })
    expect(patch.status).toBe(200)
    expect(await get(t.body.data.id)).toMatchObject({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      repeat_count: 3,
    })
  })

  test('§5.3 "+ Add" a deadline earlier than the target: next day, target kept; one undo restores', async () => {
    const fri = day(3, 16)
    const created = await send('/api/tasks', 'POST', {
      title: 'et add deadline',
      rrule: `FREQ=WEEKLY;BYDAY=${DAYS[fri.weekday - 1]}`,
      due_at: iso(fri),
    })
    expect(created.status).toBe(201)
    const before = await get(created.body.data.id)
    expect(before.repeat_anchor).toBe('target')

    const patch = patchFor(before, { type: 'addDeadline', time: '08:00', ctx: ctx() })
    expect(patch).toMatchObject({ repeat_anchor: 'deadline', target_days_before: 1 })
    const r = await send(`/api/tasks/${before.id}`, 'PATCH', patch)
    expect(r.status, r.body.error).toBe(200)
    const after = r.body.data
    expect(after.repeat_anchor).toBe('deadline')
    expect(after.rrule).toBe(`FREQ=WEEKLY;BYDAY=${DAYS[fri.weekday % 7]};BYHOUR=8;BYMINUTE=0`)
    expect(Date.parse(after.deadline_at!)).toBe(fri.plus({ days: 1 }).set({ hour: 8 }).toMillis())
    expect(after.occurrence_at).toBe(after.deadline_at)
    // The target stays exactly where it was (A2).
    expect(Date.parse(after.target_at!)).toBe(fri.toMillis())
    expect(after.target_days_before).toBe(1)
    expect(after.target_time).toBe('16:00')

    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    expect(schedule(await get(before.id))).toEqual(schedule(before))
  })

  test('§5.4 deadline → target (A3): the rule moves to the target’s days, the deadline goes', async () => {
    const deadline = day(4, 17)
    const created = await send('/api/tasks', 'POST', {
      title: 'et leave deadline',
      rrule: `FREQ=WEEKLY;BYDAY=${DAYS[deadline.weekday - 1]}`,
      deadline_at: iso(deadline),
      target_days_before: 1,
      target_time: '18:00',
    })
    expect(created.status).toBe(201)
    const before = await get(created.body.data.id)
    const patch = patchFor(before, { type: 'anchor', anchor: 'target', ctx: ctx() })
    const r = await send(`/api/tasks/${before.id}`, 'PATCH', patch)
    expect(r.status, r.body.error).toBe(200)
    expect(r.body.data.repeat_anchor).toBe('target')
    expect(r.body.data.deadline_at).toBeNull()
    expect(r.body.data.target_days_before).toBeNull()
    expect(r.body.data.rrule).toBe(
      `FREQ=WEEKLY;BYDAY=${DAYS[(deadline.weekday + 5) % 7]};BYHOUR=18;BYMINUTE=0`,
    )
    // The day before the deadline, at the target's time.
    const local = DateTime.fromISO(r.body.data.target_at!, { zone: 'utc' }).setZone(TZ)
    expect(local.weekday).toBe(deadline.minus({ days: 1 }).weekday)
    expect(local.toFormat('HH:mm')).toBe('18:00')
  })

  test('§5.2 deadline-anchored stays: new offsets re-derive the target', async () => {
    const deadline = day(5, 17)
    const created = await send('/api/tasks', 'POST', {
      title: 'et offsets',
      rrule: `FREQ=WEEKLY;BYDAY=${DAYS[deadline.weekday - 1]}`,
      deadline_at: iso(deadline),
      target_days_before: 1,
      target_time: '18:00',
    })
    const before = await get(created.body.data.id)
    const patch = patchFor(before, { type: 'daysBefore', days: 2 })
    expect(patch).toEqual({ target_days_before: 2, target_time: '18:00' })
    const r = await send(`/api/tasks/${before.id}`, 'PATCH', patch)
    expect(r.status, r.body.error).toBe(200)
    expect(Date.parse(r.body.data.target_at!)).toBe(
      deadline.minus({ days: 2 }).set({ hour: 18 }).toMillis(),
    )
    expect(r.body.data.deadline_at).toBe(before.deadline_at)
  })

  test('§5.5 Stop repeating a deadline-anchored repeat: a one-off keeping its target and deadline', async () => {
    const deadline = day(6, 17)
    const created = await send('/api/tasks', 'POST', {
      title: 'et stop',
      rrule: `FREQ=WEEKLY;BYDAY=${DAYS[deadline.weekday - 1]}`,
      deadline_at: iso(deadline),
      target_days_before: 1,
      target_time: '18:00',
    })
    const before = await get(created.body.data.id)
    const patch = patchFor(before, { type: 'stop', stop: true })
    expect(patch).toEqual({ rrule: null })
    const r = await send(`/api/tasks/${before.id}`, 'PATCH', patch)
    expect(r.status, r.body.error).toBe(200)
    expect(r.body.data.rrule).toBeNull()
    expect(r.body.data.deadline_at).toBe(before.deadline_at)
    expect(r.body.data.target_at).toBe(before.target_at)
    // Kept as a picked target, not an automatic one — and, since 2026-10-24
    // (relative targets, ruling 6), still relative: its target unmoved, the
    // one-off keeps the offsets and moves with its deadline.
    expect(r.body.data.target_auto).toBe(false)
    expect(r.body.data.target_days_before).toBe(1)
    expect(r.body.data.target_time).toBe('18:00')
  })
})
