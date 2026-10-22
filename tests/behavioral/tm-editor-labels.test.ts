/**
 * The editor's task-model labels (2026-10-12): the auto target of a
 * deadline-only task, and — 2026-10-21 — a deadline-anchored repeat's target
 * words on its deadline line. Read off the model's own rules (`autoTargetAt`,
 * the stored relative target), so these tests pin that the words follow the
 * rules (§8.1, 2026-10-12: a stored automatic target, lead 3 days
 * for a wait under 16 days, else 4).
 */
import { describe, expect, test } from 'vitest'
import {
  deadlineRepeatLabel,
  describeAutoTarget,
  occurrenceDiffers,
  relativeDaysWords,
  relativeTargetWords,
  repeatWords,
} from '@/lib/editor-target-labels'
import { DateTime } from 'luxon'

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
    // The deadline's own day (wait 0) after its morning: the target is now.
    const label = describeAutoTarget(base, TZ, CTX, new Date('2026-10-20T15:00:00Z'))
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

describe('relativeTargetWords (2026-10-22, editor plan §2.1)', () => {
  test('the words the deadline line and every-time mode share', () => {
    expect(relativeTargetWords(0, '12:00')).toBe('the same day at 12:00 PM')
    expect(relativeTargetWords(1, '18:00')).toBe('the day before at 6:00 PM')
    expect(relativeTargetWords(4, '09:30')).toBe('4 days before at 9:30 AM')
    expect(relativeDaysWords(2)).toBe('2 days before')
  })
})

describe('occurrenceDiffers — "This is the Fri Oct 23 one" (editor plan §7, A4)', () => {
  const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
  // Weekly on Friday at 4 PM, on its rule.
  const fridays = {
    rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
    recurrence_mode: 'from_due' as const,
    anchor_time: '16:00',
    repeat_anchor: 'target' as const,
    due_at: at('2026-10-23T16:00'),
    occurrence_at: at('2026-10-23T16:00'),
    done: false,
  }
  // Monthly on the 1st Saturday at 8 AM; target the day before at 6 PM.
  const homeDepot = {
    rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
    recurrence_mode: 'from_due' as const,
    anchor_time: '08:00',
    repeat_anchor: 'deadline' as const,
    target_days_before: 1,
    target_time: '18:00',
    due_at: at('2026-11-06T18:00'),
    occurrence_at: at('2026-11-07T08:00'),
  }

  test('not shown on its rule — Home Depot, Fridays', () => {
    expect(occurrenceDiffers(fridays, TZ, true)).toBe(null)
    expect(occurrenceDiffers(homeDepot, TZ, true)).toBe(null)
  })

  test('(a) on deck', () => {
    expect(
      occurrenceDiffers({ ...fridays, due_at: null, on_deck_day: '2026-10-22' }, TZ, false),
    ).toBe('Fri Oct 23')
  })

  test('(b) moved', () => {
    expect(occurrenceDiffers({ ...fridays, due_at: at('2026-10-24T10:00') }, TZ, false)).toBe(
      'Fri Oct 23',
    )
  })

  test('(c) queued — only with the queue switch on', () => {
    const queued = { ...fridays, queued_at: at('2026-10-22T06:00') }
    expect(occurrenceDiffers(queued, TZ, true)).toBe('Fri Oct 23')
    expect(occurrenceDiffers(queued, TZ, false)).toBe(null)
  })

  test('(d) rescheduled off its rule — names the deadline’s day, "(deadline)" when the target’s differs', () => {
    const pulled = {
      ...homeDepot,
      occurrence_at: at('2026-11-06T08:00'),
      due_at: at('2026-11-05T18:00'),
    }
    expect(occurrenceDiffers(pulled, TZ, false)).toBe('Fri Nov 6 (deadline)')
    // The same day: no "(deadline)".
    const sameDay = {
      ...pulled,
      target_days_before: 0,
      target_time: '07:00',
      due_at: at('2026-11-06T07:00'),
    }
    expect(occurrenceDiffers(sameDay, TZ, false)).toBe('Fri Nov 6')
    // from_completion has no rule days to be off.
    expect(occurrenceDiffers({ ...pulled, recurrence_mode: 'from_completion' }, TZ, false)).toBe(
      null,
    )
  })

  test('a decked deadline-anchored repeat names its deadline’s day', () => {
    expect(
      occurrenceDiffers({ ...homeDepot, due_at: null, on_deck_day: '2026-10-22' }, TZ, false),
    ).toBe('Sat Nov 7 (deadline)')
  })

  test('negatives: plain over-target debt, done, a one-off, no occurrence', () => {
    const over = {
      ...fridays,
      due_at: at('2026-10-16T16:00'),
      occurrence_at: at('2026-10-16T16:00'),
    }
    expect(occurrenceDiffers(over, TZ, true)).toBe(null)
    expect(
      occurrenceDiffers({ ...fridays, due_at: null, on_deck_day: 'x', done: true }, TZ, true),
    ).toBe(null)
    expect(
      occurrenceDiffers({ ...fridays, rrule: null, on_deck_day: '2026-10-22' }, TZ, true),
    ).toBe(null)
    expect(occurrenceDiffers({ ...fridays, occurrence_at: null, on_deck_day: 'x' }, TZ, true)).toBe(
      null,
    )
  })
})

describe('repeatWords — the this-one link (editor PR 4c)', () => {
  test('the rule; a deadline-anchored one says its time is the deadline; ends exactly', () => {
    const fri = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'
    expect(repeatWords({ rrule: fri })).toBe('Fridays at 4:00 PM')
    expect(
      repeatWords({
        rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
        repeat_anchor: 'deadline',
      }),
    ).toBe('Monthly on the 1st Sat, deadline 8:00 AM')
    expect(repeatWords({ rrule: fri, repeat_count: 6 })).toBe('Fridays at 4:00 PM, 6 times')
    expect(repeatWords({ rrule: fri, repeat_until: '2026-12-31' })).toBe(
      'Fridays at 4:00 PM, until Dec 31, 2026',
    )
  })
})
