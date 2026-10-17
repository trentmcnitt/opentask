/**
 * A repeating task CREATED with a date today whose time has passed starts at
 * its next occurrence (rollPassedFirstOccurrence, designer 2026-10-16) — the
 * #258 day-0 ruling extended to a dated create. In createTask, so every client
 * and mode gets it. Not reminders (today's occurrence is still today's to
 * consider), not a date before today, not a date still ahead.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { createTask } from '@/core/tasks'
import { rollPassedFirstOccurrence } from '@/core/recurrence'

// Fri Oct 16 2026, Chicago (CDT, UTC-5).
const at = (local: string) => new Date(`2026-10-16T${local}:00-05:00`)
const utc = (local: string) => new Date(`${local}:00-05:00`).toISOString()

describe('rollPassedFirstOccurrence', () => {
  const roll = (rrule: string, due: string, now: string) =>
    rollPassedFirstOccurrence(rrule, new Date(utc(due)), TEST_TIMEZONE, at(now)).toISOString()

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

  test('unchanged: still ahead today, a date before today, a date after today', () => {
    const weekly = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'
    expect(roll(weekly, '2026-10-16T17:00', '15:00')).toBe(utc('2026-10-16T17:00'))
    expect(roll(weekly, '2026-10-09T17:00', '20:30')).toBe(utc('2026-10-09T17:00'))
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

  test('no date given: computeFirstOccurrence as before (made after its time → next week)', () => {
    vi.setSystemTime(at('20:30'))
    const task = create({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0' })
    expect(task.due_at).toBe(utc('2026-10-23T17:00'))
  })
})
