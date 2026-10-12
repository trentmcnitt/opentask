/**
 * The editor's task-model labels (2026-10-12): the auto target of a
 * deadline-only task, and the "moves with each week" note on a recurring
 * task's deadline. Both are read off the model's own rules
 * (`impliedTargetAt`, `advanceDeadline`), so these tests pin that the words
 * follow the rules — including ruling A4's deadline-day re-arm.
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
  test('a deadline with no target: the morning 4 days before, said as such', () => {
    const label = describeAutoTarget(
      { due_at: null, deadline_at: DEADLINE, deadline_nag_off: false, rrule: null },
      TZ,
      CTX,
      BEFORE,
    )
    // Fri Oct 16, 9:00 AM CDT.
    expect(label).toEqual({
      at: '2026-10-16T14:00:00.000Z',
      lead: '4 days before deadline',
      started: false,
    })
  })

  test('A4: with the nag off, the deadline day re-arms — "deadline day"', () => {
    const label = describeAutoTarget(
      { due_at: null, deadline_at: DEADLINE, deadline_nag_off: true, rrule: null },
      TZ,
      CTX,
      BEFORE,
    )
    expect(label).toEqual({ at: '2026-10-20T14:00:00.000Z', lead: 'deadline day', started: false })
  })

  test('A4: a deadline before the morning re-arms at the deadline itself', () => {
    // Tue Oct 20, 7:00 AM CDT — earlier than the 9:00 morning.
    const early = '2026-10-20T12:00:00.000Z'
    const label = describeAutoTarget(
      { due_at: null, deadline_at: early, deadline_nag_off: true, rrule: null },
      TZ,
      CTX,
      BEFORE,
    )
    expect(label).toEqual({ at: early, lead: 'deadline day', started: false })
  })

  test('started once the implied target has arrived', () => {
    const label = describeAutoTarget(
      { due_at: null, deadline_at: DEADLINE, deadline_nag_off: false, rrule: null },
      TZ,
      CTX,
      new Date('2026-10-17T15:00:00Z'),
    )
    expect(label?.started).toBe(true)
  })

  test('none for a task with a target, no deadline, or a recurrence', () => {
    const base = { due_at: null, deadline_at: DEADLINE, deadline_nag_off: false, rrule: null }
    expect(describeAutoTarget({ ...base, due_at: '2026-10-15T14:00:00Z' }, TZ, CTX, BEFORE)).toBe(
      null,
    )
    expect(describeAutoTarget({ ...base, deadline_at: null }, TZ, CTX, BEFORE)).toBe(null)
    // Recurring tasks never get an implied target.
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
