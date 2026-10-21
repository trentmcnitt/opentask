/**
 * The editor's task-model labels (2026-10-12): the auto target of a
 * deadline-only task, and — 2026-10-21 — a deadline-anchored repeat's target
 * words on its deadline line. Read off the model's own rules (`autoTargetAt`,
 * the stored relative target), so these tests pin that the words follow the
 * rules (§8.1, 2026-10-12: a stored automatic target, lead 3 days
 * for a wait under 16 days, else 4).
 */
import { describe, expect, test } from 'vitest'
import { describeAutoTarget, deadlineRepeatLabel } from '@/lib/editor-target-labels'

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
  // Deadline Sundays at 11 PM (2026-10-21: a deadline-anchored repeat).
  const task = {
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0',
    repeat_anchor: 'deadline' as const,
    target_days_before: 0,
    target_time: '12:00',
  }

  test('says where the target sits before the deadline', () => {
    expect(deadlineRepeatLabel(task)).toBe('target the same day at 12:00 PM')
    expect(deadlineRepeatLabel({ ...task, target_days_before: 1, target_time: '18:00' })).toBe(
      'target the day before at 6:00 PM',
    )
    expect(deadlineRepeatLabel({ ...task, target_days_before: 3, target_time: '09:00' })).toBe(
      'target 3 days before at 9:00 AM',
    )
  })

  test('nothing for a target-anchored repeat or a one-off', () => {
    expect(deadlineRepeatLabel({ ...task, repeat_anchor: 'target' })).toBe(null)
    expect(deadlineRepeatLabel({ ...task, rrule: null })).toBe(null)
  })
})
