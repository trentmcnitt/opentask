/**
 * The editor's task-model labels (2026-10-12): the auto target of a
 * deadline-only task, and the "moves with each week" note on a recurring
 * task's deadline. Both are read off the model's own rules
 * (`autoTargetAt`, `advanceDeadline`), so these tests pin that the words
 * follow the rules (§8.1, 2026-10-12: a stored automatic target, lead 3 days
 * for a wait under 16 days, else 4).
 */
import { describe, expect, test } from 'vitest'
import { describeAutoTarget, deadlineRepeatLabel } from '@/lib/editor-target-labels'
import { advanceDeadline } from '@/lib/task-segments'

const TZ = 'America/Chicago'
const CTX = { timezone: TZ, morningTime: '09:00' }
// Tue Oct 20 2026, 11:00 PM Chicago (CDT, UTC−5).
const DEADLINE = '2026-10-21T04:00:00.000Z'
const BEFORE = new Date('2026-10-12T15:00:00Z')

describe('describeAutoTarget', () => {
  const base = { due_at: null, deadline_at: DEADLINE, rrule: null }

  test('a deadline with no target yet: the automatic target, said as such', () => {
    // Set Mon Oct 12 → an 8-day wait, lead 3 → Sat Oct 17, 9:00 AM CDT.
    expect(describeAutoTarget(base, TZ, CTX, BEFORE)).toEqual({
      at: '2026-10-17T14:00:00.000Z',
      lead: '3 days before deadline',
      started: false,
    })
  })

  test('a wait of 16 days or more takes a 4-day lead', () => {
    // Set Sun Sep 27 (Chicago) → a 23-day wait → Fri Oct 16, 9:00 AM CDT.
    expect(describeAutoTarget(base, TZ, CTX, new Date('2026-09-27T15:00:00Z'))).toEqual({
      at: '2026-10-16T14:00:00.000Z',
      lead: '4 days before deadline',
      started: false,
    })
  })

  test('a STORED auto target is read as it is, not recomputed', () => {
    const stored = { ...base, due_at: '2026-10-16T14:00:00.000Z', target_auto: true }
    expect(describeAutoTarget(stored, TZ, CTX, BEFORE)).toEqual({
      at: '2026-10-16T14:00:00.000Z',
      lead: '4 days before deadline',
      started: false,
    })
  })

  test('preview: a picked target staged back to auto shows what Save would store', () => {
    const picked = { ...base, due_at: '2026-10-13T14:00:00.000Z', target_auto: false }
    expect(describeAutoTarget(picked, TZ, CTX, BEFORE)).toBe(null)
    expect(describeAutoTarget(picked, TZ, CTX, BEFORE, true)).toEqual({
      at: '2026-10-17T14:00:00.000Z',
      lead: '3 days before deadline',
      started: false,
    })
  })

  test('a deadline already passed: the deadline itself, "deadline day", started', () => {
    const after = new Date('2026-10-21T15:00:00Z')
    expect(describeAutoTarget(base, TZ, CTX, after)).toEqual({
      at: DEADLINE,
      lead: 'deadline day',
      started: true,
    })
  })

  test('started once the automatic target has arrived', () => {
    const label = describeAutoTarget(base, TZ, CTX, new Date('2026-10-17T15:00:00Z'))
    expect(label?.started).toBe(true)
  })

  test('none for a picked target, no deadline, or a recurrence', () => {
    expect(describeAutoTarget({ ...base, due_at: '2026-10-15T14:00:00Z' }, TZ, CTX, BEFORE)).toBe(
      null,
    )
    expect(describeAutoTarget({ ...base, deadline_at: null }, TZ, CTX, BEFORE)).toBe(null)
    // Recurring tasks never get an automatic target.
    expect(describeAutoTarget({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=SU' }, TZ, CTX, BEFORE)).toBe(
      null,
    )
  })
})

describe('deadlineRepeatLabel', () => {
  // Sundays at noon, deadline 11 PM the same Sunday.
  const task = {
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
    due_at: '2026-10-18T17:00:00.000Z',
    original_due_at: '2026-10-18T17:00:00.000Z',
    deadline_at: '2026-10-19T04:00:00.000Z',
  }

  test('weekly: "moves with each week" — and advanceDeadline really moves it', () => {
    expect(deadlineRepeatLabel(task)).toBe('moves with each week')
    // The next Sunday's noon → that Sunday's 11 PM.
    expect(advanceDeadline(task, '2026-10-25T17:00:00.000Z', TZ)).toBe('2026-10-26T04:00:00.000Z')
  })

  test('each day / month / year; every-N rules say "each occurrence"', () => {
    expect(deadlineRepeatLabel({ ...task, rrule: 'FREQ=DAILY' })).toBe('moves with each day')
    expect(deadlineRepeatLabel({ ...task, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' })).toBe(
      'moves with each month',
    )
    expect(deadlineRepeatLabel({ ...task, rrule: 'FREQ=YEARLY' })).toBe('moves with each year')
    expect(deadlineRepeatLabel({ ...task, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU' })).toBe(
      'moves with each occurrence',
    )
  })

  test('nothing to claim without a rule, a deadline, or an occurrence to measure from', () => {
    expect(deadlineRepeatLabel({ ...task, rrule: null })).toBe(null)
    expect(deadlineRepeatLabel({ ...task, deadline_at: null })).toBe(null)
    const noOccurrence = { ...task, due_at: null, original_due_at: null }
    expect(deadlineRepeatLabel(noOccurrence)).toBe(null)
    // …which is exactly when advanceDeadline leaves the deadline where it is.
    expect(advanceDeadline(noOccurrence, '2026-10-25T17:00:00.000Z', TZ)).toBe(task.deadline_at)
  })
})
