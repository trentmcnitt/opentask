/**
 * A NEW repeating task created with a date already past — earlier today (#286)
 * or any earlier day (2026-10-16 follow-up) — starts at its next occurrence
 * (rollPassedFirstOccurrence, designer 2026-10-16), the #258 day-0 ruling
 * extended to a dated create. In createTask, so every client and mode gets it.
 * Not reminders (today's occurrence is still today's to consider), not a date
 * still ahead, and never a later EDIT of an existing task's date.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { createTask, getTaskById } from '@/core/tasks'
import { updateTask } from '@/core/tasks/update'
import { rollPassedFirstOccurrence } from '@/core/recurrence'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

// Fri Oct 16 2026, Chicago (CDT, UTC-5).
const at = (local: string) => new Date(`2026-10-16T${local}:00-05:00`)
const utc = (local: string) => new Date(`${local}:00-05:00`).toISOString()
// Nov 15, 9 AM Chicago: CST (UTC-6), after the DST change.
const NOV15_9AM = '2026-11-15T15:00:00.000Z'

describe('rollPassedFirstOccurrence', () => {
  const roll = (rrule: string, due: string, now: string) =>
    rollPassedFirstOccurrence(
      rrule,
      new Date(utc(due)),
      TEST_TIMEZONE,
      at(now),
      CALENDAR_DAY_START,
    ).toISOString()

  test('weekly Friday 5 PM made Friday 8:30 PM → next Friday 5 PM', () => {
    expect(roll('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-16T17:00', '20:30')).toBe(
      utc('2026-10-23T17:00'),
    )
  })

  test('daily → tomorrow, at the given time even when the rule has no BYHOUR', () => {
    expect(roll('FREQ=DAILY', '2026-10-16T07:00', '10:00')).toBe(utc('2026-10-17T07:00'))
  })

  test('every 2 weeks on Friday made after its time → the next grid point, two weeks on', () => {
    expect(
      roll('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-16T17:00', '20:30'),
    ).toBe(utc('2026-10-30T17:00'))
  })

  test('an earlier day rolls too: the 15th of every month, given Oct 15, made Oct 16 → Nov 15', () => {
    expect(roll('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-15T09:00', '10:00')).toBe(NOV15_9AM)
    // A weekly Friday given last Friday → next Friday.
    expect(roll('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-09T17:00', '20:30')).toBe(
      utc('2026-10-23T17:00'),
    )
  })

  test('unchanged: still ahead today, a date after today', () => {
    const weekly = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'
    expect(roll(weekly, '2026-10-16T17:00', '15:00')).toBe(utc('2026-10-16T17:00'))
    expect(roll(weekly, '2026-10-23T17:00', '20:30')).toBe(utc('2026-10-23T17:00'))
  })
})

describe('createTask', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  const create = (input: Record<string, unknown>) =>
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Synthetic task', ...input },
    })

  test('given today 5 PM at 8:30 PM, a weekly Friday starts next Friday (target and occurrence)', () => {
    vi.setSystemTime(at('20:30'))
    const task = create({
      due_at: utc('2026-10-16T17:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
    })
    expect(task.due_at).toBe(utc('2026-10-23T17:00'))
    expect(task.occurrence_at).toBe(utc('2026-10-23T17:00'))
  })

  test('made before its time, it keeps today', () => {
    vi.setSystemTime(at('15:00'))
    const task = create({
      due_at: utc('2026-10-16T17:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
    })
    expect(task.due_at).toBe(utc('2026-10-16T17:00'))
  })

  test('a one-off given a past time today is untouched (only repeats roll)', () => {
    vi.setSystemTime(at('20:30'))
    expect(create({ due_at: utc('2026-10-16T17:00') }).due_at).toBe(utc('2026-10-16T17:00'))
  })

  test("a reminder keeps today's occurrence, even past its time", () => {
    vi.setSystemTime(at('20:30'))
    const task = create({
      is_reminder: true,
      due_at: utc('2026-10-16T17:00'),
      rrule: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0',
    })
    expect(task.due_at).toBe(utc('2026-10-16T17:00'))
  })

  test('the mortgage case: "15th of every month" given Oct 15, made Oct 16 → Nov 15', () => {
    vi.setSystemTime(at('10:00'))
    const task = create({ due_at: utc('2026-10-15T09:00'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' })
    expect(task.due_at).toBe(NOV15_9AM)
    expect(task.occurrence_at).toBe(NOV15_9AM)
  })

  test('a reminder given an earlier day is NOT rolled', () => {
    vi.setSystemTime(at('10:00'))
    const task = create({
      is_reminder: true,
      due_at: utc('2026-10-14T07:00'),
      rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    })
    expect(task.due_at).toBe(utc('2026-10-14T07:00'))
  })

  test("an EDIT moving an existing repeating task's date into the past is NOT rolled", () => {
    vi.setSystemTime(at('10:00'))
    const task = create({
      due_at: utc('2026-10-20T09:00'),
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: utc('2026-10-13T09:00') },
    })
    expect(getTaskById(task.id)!.due_at).toBe(utc('2026-10-13T09:00'))
  })

  test('no date given: computeFirstOccurrence as before (made after its time → next week)', () => {
    vi.setSystemTime(at('20:30'))
    const task = create({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0' })
    expect(task.due_at).toBe(utc('2026-10-23T17:00'))
  })
})
