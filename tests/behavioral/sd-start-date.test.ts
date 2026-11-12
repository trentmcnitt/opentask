/**
 * START DATE for deadline tasks (2026-11-12; docs/TASK-MODEL.md § Start date;
 * rules START-1..7 in src/lib/task-segments.ts). `sd-`:
 *  - SD-01..04 the pure rules: the daily day C, the limit, the rounds;
 *  - SD-10 THE STATE TABLE: where the task is on each kind of day, by horizon;
 *  - SD-20..27 the write rules (create, PATCH, later changes, Defer, undo);
 *  - SD-30 the day-by-day simulation, Jan 1 → Mar 31.
 *
 * Synthetic data only. Task queue on (the day starts at 3:00 AM), check-in
 * day Saturday. America/Chicago. The long shape: a Weeks task with a deadline
 * of Wed 2027-03-31 23:59 and a start of Fri 2027-01-01.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  dismissPromptNotifications: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { considerTasks, deferLeads, getTaskSegments } from '@/core/tasks/task-segments'
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import {
  comingDueDay,
  deadlineWindowOf,
  latestRound,
  nextRound,
  startDateProblem,
  type HorizonValue,
} from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const ROLLOVER = '03:00'
const SAT = 6
const u = { userId: TEST_USER_ID, userTimezone: tz }
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
const setClock = (local: string) => vi.setSystemTime(new Date(at(local)))
const task = (id: number) => getTaskById(id)!
const DEADLINE = at('2027-03-31T23:59')

const make = (input: Record<string, unknown> = {}) =>
  createTask({
    ...u,
    input: { title: 'Synthetic gift card', horizon: 'weeks', deadline_at: DEADLINE, ...input },
  })

const WEB = {
  queuePanels: true,
  deckRows: true,
  handledRows: true,
  deadlineRows: true,
  newRows: true,
  fill: false,
}
/** Where task `id` is now: `<segment>:<state>` plus `:open` / `:net` on a Due row. */
function where(id: number): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), WEB).flatMap((s) =>
    s.tasks
      .filter((r) => r.task.id === id)
      .map(
        (r) =>
          `${s.horizon}:${r.state}` +
          (r.window === 'open' ? ':open' : '') +
          (r.safetyNet ? ':net' : ''),
      ),
  )
}

beforeEach(() => {
  setupTestDb()
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  vi.useFakeTimers({ toFake: ['Date'] })
  setClock('2026-11-12T10:00')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('SD-0x the pure rules', () => {
  test('SD-01: the daily day C is the lead table’s days for the wait from the start, at least one', () => {
    // 89 days from Jan 1 to Mar 31: the table says 4 → Sat Mar 27.
    expect(comingDueDay(DEADLINE, '2027-01-01', tz, ROLLOVER)).toBe('2027-03-27')
    // 10 days: 3 → Mar 28. 5 days: 1 → Mar 30, the net's first day.
    expect(comingDueDay(DEADLINE, '2027-03-21', tz, ROLLOVER)).toBe('2027-03-28')
    expect(comingDueDay(DEADLINE, '2027-03-26', tz, ROLLOVER)).toBe('2027-03-30')
    expect(comingDueDay(DEADLINE, '2027-03-29', tz, ROLLOVER)).toBe('2027-03-30')
  })

  test('SD-02: any date up to D−2, however far; inside the net refused; no deadline refused', () => {
    expect(startDateProblem('2026-01-01', DEADLINE, tz, ROLLOVER)).toBeNull()
    expect(startDateProblem('2027-03-29', DEADLINE, tz, ROLLOVER)).toBeNull()
    expect(startDateProblem('2027-03-30', DEADLINE, tz, ROLLOVER)).toBe('in_safety_net')
    expect(startDateProblem('2027-03-31', DEADLINE, tz, ROLLOVER)).toBe('in_safety_net')
    expect(startDateProblem('2027-01-01', null, tz, ROLLOVER)).toBe('no_deadline')
  })

  test('SD-03: the start is a round; the first cadence round is a full step after it', () => {
    const round = (h: HorizonValue | null, today: string) =>
      latestRound('2027-01-01', h, SAT, today, tz)
    // Weeks: Sat Jan 2 is too close (a full week is Jan 8); Sat Jan 9 is the first.
    expect(round('weeks', '2027-01-01')).toBe('2027-01-01')
    expect(round('weeks', '2027-01-02')).toBe('2027-01-01')
    expect(round('weeks', '2027-01-08')).toBe('2027-01-01')
    expect(round('weeks', '2027-01-09')).toBe('2027-01-09')
    expect(round('weeks', '2027-01-15')).toBe('2027-01-09')
    // Unset reads as weeks.
    expect(round(null, '2027-01-09')).toBe('2027-01-09')
    // Days: the next day.
    expect(round('days', '2027-01-02')).toBe('2027-01-02')
    // Months: the first Saturday of a month, at least a month on: Feb 6.
    expect(round('months', '2027-01-31')).toBe('2027-01-01')
    expect(round('months', '2027-02-06')).toBe('2027-02-06')
    // Eventually: the quarter's first Saturday, at least three months on: Apr 3.
    expect(round('eventually', '2027-03-31')).toBe('2027-01-01')
    expect(round('eventually', '2027-04-03')).toBe('2027-04-03')
  })

  test('SD-04: the next round, up to the day it becomes daily; none after the last', () => {
    const next = (h: HorizonValue, today: string) =>
      nextRound('2027-01-01', '2027-03-27', h, SAT, today, tz)
    expect(next('weeks', '2027-01-01')).toBe('2027-01-09')
    expect(next('weeks', '2027-03-19')).toBe('2027-03-20')
    expect(next('weeks', '2027-03-20')).toBeNull() // Mar 27 is the daily day, not a round
    expect(next('months', '2027-01-01')).toBe('2027-02-06')
    expect(next('eventually', '2027-01-01')).toBeNull()
  })
})

describe('SD-10 the state table (START-3)', () => {
  // [horizon, day, never considered → where, considered on its latest round → where]
  const ROWS: [HorizonValue, string, string[], string[]][] = [
    // Before the start: nowhere.
    ['weeks', '2026-12-31', [], []],
    // The start day: a round.
    ['weeks', '2027-01-01', ['deadlines:waiting:open'], ['deadlines:considered:open']],
    // Between rounds: carried over until considered, then quiet.
    ['weeks', '2027-01-05', ['deadlines:waiting:open'], []],
    // A cadence round.
    ['weeks', '2027-01-09', ['deadlines:waiting:open'], ['deadlines:considered:open']],
    ['months', '2027-01-09', ['deadlines:waiting:open'], []],
    ['months', '2027-02-06', ['deadlines:waiting:open'], ['deadlines:considered:open']],
    ['days', '2027-01-05', ['deadlines:waiting:open'], ['deadlines:considered:open']],
    ['eventually', '2027-03-20', ['deadlines:waiting:open'], []],
    // Coming due: daily, an ordinary Due row.
    ['weeks', '2027-03-27', ['deadlines:waiting'], ['deadlines:considered']],
    ['weeks', '2027-03-28', ['deadlines:waiting'], ['deadlines:considered']],
    // The safety net: no consider silences it.
    ['weeks', '2027-03-30', ['deadlines:waiting:net'], ['deadlines:waiting:net']],
    ['weeks', '2027-03-31', ['deadlines:waiting:net'], ['deadlines:waiting:net']],
  ]

  test.each(ROWS)('%s on %s', (horizon, day, fresh, seen) => {
    const t = make({ horizon, start_date: '2027-01-01' })
    setClock(`${day}T10:00`)
    expect(where(t.id)).toEqual(fresh)
    // Considered on the latest round day (or today, when today is one).
    const round = latestRound('2027-01-01', horizon, SAT, day, tz)
    const daily = day >= '2027-03-27'
    if (day >= '2027-01-01') {
      setClock(`${daily ? day : round}T09:00`)
      considerTasks(TEST_USER_ID, [t.id])
      setClock(`${day}T10:00`)
    }
    expect(where(t.id)).toEqual(seen)
  })

  test('SD-11: with no start date, or Days, there is no open window (today’s behaviour)', () => {
    const plain = make()
    const days = make({ lead_days: 30 })
    expect(task(plain.id)).toMatchObject({ start_date: null, lead_from: '2027-03-27' })
    expect(task(days.id)).toMatchObject({ start_date: null, lead_from: '2027-03-01' })
    setClock('2027-03-05T10:00')
    expect(where(plain.id)).toEqual([])
    expect(where(days.id)).toEqual(['deadlines:waiting'])
  })

  test('SD-12: the stage the API reports (deadline_window, next_round)', () => {
    const t = make({ start_date: '2027-01-01' })
    const stage = (local: string) =>
      deadlineWindowOf(task(t.id), tz, new Date(at(local)), ROLLOVER, SAT)
    expect(stage('2026-12-31T10:00')).toEqual({ window: 'before_start', nextRound: null })
    expect(stage('2027-01-01T10:00')).toEqual({ window: 'open', nextRound: '2027-01-09' })
    expect(stage('2027-03-27T10:00')).toEqual({ window: 'coming_due', nextRound: null })
    expect(stage('2027-03-30T10:00')).toEqual({ window: 'safety_net', nextRound: null })
    // A task with a target has no stage.
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2027-02-01T09:00') } })
    expect(stage('2027-01-05T10:00')).toBeNull()
  })
})

describe('SD-2x the write rules (START-1, START-2, START-7)', () => {
  const patch = (id: number, input: Record<string, unknown>) =>
    updateTask({ ...u, taskId: id, input })

  test('SD-20: created with a date: stored, and its window starts that day', () => {
    const t = make({ start_date: '2027-01-01' })
    expect(task(t.id)).toMatchObject({
      start_date: '2027-01-01',
      lead_from: '2027-01-01',
      lead_days: null,
      due_at: null,
    })
  })

  test('SD-21: a date in the past starts today; a date inside the net, or with no deadline, or on a repeat, is a 400', () => {
    const past = make({ start_date: '2026-01-01' })
    expect(task(past.id)).toMatchObject({ start_date: '2026-01-01', lead_from: '2026-01-01' })
    expect(where(past.id)).toEqual(['deadlines:waiting:open'])
    expect(() => make({ start_date: '2027-03-30' })).toThrow(ValidationError)
    expect(() => make({ deadline_at: null, start_date: '2027-01-01' })).toThrow(ValidationError)
    expect(() =>
      make({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59', start_date: '2027-01-01' }),
    ).toThrow(ValidationError)
    const t = make()
    expect(() => patch(t.id, { start_date: '2027-03-31' })).toThrow(ValidationError)
  })

  test('SD-22: one choice: a date clears lead_days, Days clears the date, both at once is a 400', () => {
    const t = make({ lead_days: 12 })
    patch(t.id, { start_date: '2027-01-01' })
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-01', lead_days: null })
    patch(t.id, { lead_days: 12 })
    expect(task(t.id)).toMatchObject({
      start_date: null,
      lead_days: 12,
      lead_from: '2027-03-19',
    })
    expect(() => patch(t.id, { start_date: '2027-01-01', lead_days: 5 })).toThrow(ValidationError)
    expect(() => make({ start_date: '2027-01-01', lead_days: 5 })).toThrow(ValidationError)
  })

  test('SD-23: the deadline moves: the date stays unless it lands inside the net', () => {
    const t = make({ start_date: '2027-01-01' })
    patch(t.id, { deadline_at: at('2027-04-30T23:59') })
    expect(task(t.id).start_date).toBe('2027-01-01')
    patch(t.id, { deadline_at: at('2027-01-10T23:59') })
    expect(task(t.id).start_date).toBe('2027-01-01')
    // Deadline Jan 2: the start (Jan 1) is D−1, inside the net → the default lead.
    patch(t.id, { deadline_at: at('2027-01-02T23:59') })
    expect(task(t.id)).toMatchObject({ start_date: null, lead_days: null })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-01', lead_from: '2027-01-01' })
  })

  test('SD-24: the deadline removed, or made to repeat, or a reminder: the date goes', () => {
    const a = make({ start_date: '2027-01-01' })
    patch(a.id, { deadline_at: null })
    expect(task(a.id)).toMatchObject({ start_date: null, lead_from: null })
    const b = make({ start_date: '2027-01-01' })
    patch(b.id, {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59',
      repeat_anchor: 'deadline',
    })
    expect(task(b.id).start_date).toBeNull()
    const c = make({ start_date: '2027-01-01' })
    patch(c.id, { is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    expect(task(c.id).start_date).toBeNull()
  })

  test('SD-25: a picked target keeps the date, inert; Remove target brings the window back', () => {
    const t = make({ start_date: '2027-01-01' })
    patch(t.id, { due_at: at('2027-02-01T09:00') })
    expect(task(t.id).start_date).toBe('2027-01-01')
    setClock('2027-01-09T10:00')
    expect(where(t.id)).toEqual([])
    patch(t.id, { due_at: null })
    expect(where(t.id)).toEqual(['deadlines:waiting:open'])
  })

  test('SD-26: Defer on an open-window row moves the start (tap = tomorrow); the row is back that day', () => {
    const t = make({ start_date: '2027-01-01' })
    setClock('2027-01-01T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:open'])
    const result = deferLeads(TEST_USER_ID, tz, [t.id])
    expect(result.deferred).toBe(1)
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-02', lead_from: '2027-01-02' })
    expect(where(t.id).filter((w) => !w.includes('considered'))).toEqual([])
    setClock('2027-01-02T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:open'])
    // Its rounds now count from the new start: Sat Jan 9 is a full week on.
    setClock('2027-01-02T11:00')
    considerTasks(TEST_USER_ID, [t.id])
    setClock('2027-01-08T10:00')
    expect(where(t.id)).toEqual([])
    setClock('2027-01-09T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:open'])
  })

  test('SD-28: Defer on a Coming-due row keeps its start date: it is daily when it is back', () => {
    const t = make({ start_date: '2027-01-01' })
    setClock('2027-03-27T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting'])
    deferLeads(TEST_USER_ID, tz, [t.id])
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-01', lead_from: '2027-03-28' })
    setClock('2027-03-28T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting'])
    considerTasks(TEST_USER_ID, [t.id])
    setClock('2027-03-29T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting'])
  })

  test('SD-29: a PATCH of start_date moves the stored first day; clearing it puts the default lead back', () => {
    const t = make()
    expect(task(t.id).lead_from).toBe('2027-03-27')
    patch(t.id, { start_date: '2027-01-01' })
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-01', lead_from: '2027-01-01' })
    patch(t.id, { start_date: null })
    expect(task(t.id)).toMatchObject({ start_date: null, lead_from: '2027-03-27' })
  })

  test('SD-2A: a deadline moved mid-window keeps the rounds where they were', () => {
    const t = make({ start_date: '2027-01-01' })
    setClock('2027-01-09T10:00')
    considerTasks(TEST_USER_ID, [t.id])
    setClock('2027-01-12T10:00')
    expect(where(t.id)).toEqual([])
    patch(t.id, { deadline_at: at('2027-04-30T23:59') })
    expect(task(t.id)).toMatchObject({ start_date: '2027-01-01', lead_from: '2027-01-01' })
    expect(where(t.id)).toEqual([])
    setClock('2027-01-16T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:open'])
  })

  test('SD-27: Defer on a row with no date leaves it without one (today’s behaviour)', () => {
    const t = make({ lead_days: 30 })
    setClock('2027-03-05T10:00')
    deferLeads(TEST_USER_ID, tz, [t.id], '2027-03-10')
    expect(task(t.id)).toMatchObject({ start_date: null, lead_from: '2027-03-10', lead_days: 30 })
  })
})

describe('SD-30 the simulation: Jan 1 → Mar 31, considered whenever it waits', () => {
  test('listed on Jan 1, eleven Saturdays (Jan 9 … Mar 20), daily from Mar 27, the net on Mar 30 and 31', () => {
    const t = make({ start_date: '2027-01-01' })
    const listed: string[] = []
    const open: string[] = []
    for (
      let day = DateTime.fromISO('2026-12-28', { zone: tz });
      day.toISODate()! <= '2027-03-31';
      day = day.plus({ days: 1 })
    ) {
      vi.setSystemTime(day.set({ hour: 10 }).toJSDate())
      const place = where(t.id)
      if (place.some((p) => p.includes(':waiting'))) {
        listed.push(day.toISODate()!)
        if (place[0].includes(':open')) open.push(day.toISODate()!)
        considerTasks(TEST_USER_ID, [t.id])
      }
    }
    const saturdays = [
      '2027-01-09',
      '2027-01-16',
      '2027-01-23',
      '2027-01-30',
      '2027-02-06',
      '2027-02-13',
      '2027-02-20',
      '2027-02-27',
      '2027-03-06',
      '2027-03-13',
      '2027-03-20',
    ]
    expect(open).toEqual(['2027-01-01', ...saturdays])
    expect(listed).toEqual([
      '2027-01-01',
      ...saturdays,
      '2027-03-27',
      '2027-03-28',
      '2027-03-29',
      '2027-03-30',
      '2027-03-31',
    ])
  })
})
