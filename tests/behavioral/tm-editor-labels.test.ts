/**
 * The editor's task-model labels: the Lead row of a deadline task with no
 * target (the deadlines page, 2026-10-22 — it replaced the automatic target's
 * "auto" line), and — 2026-10-21 — a deadline-anchored repeat's target words
 * on its deadline line. Read off the model's own rules (`leadFor`, the stored
 * relative target), so these tests pin that the words follow the rules.
 */
import { describe, expect, test } from 'vitest'
import {
  deadlineRepeatLabel,
  leadDaysWords,
  leadLine,
  leadLineWords,
  occurrenceDiffers,
  relativeDaysWords,
  relativeTargetWords,
  repeatWords,
} from '@/lib/editor-target-labels'
import { DateTime } from 'luxon'

const TZ = 'America/Chicago'

describe("leadLine — the editor's Lead row (the deadlines page, 2026-10-22)", () => {
  // Fri Oct 30 2026, 11:59 PM Chicago (CDT).
  const D = '2026-10-31T04:59:00.000Z'
  // Tue Oct 20, noon CDT: a 10-day wait → the 3-day lead → Tue Oct 27.
  const NOW = new Date('2026-10-20T17:00:00Z')
  const base = {
    due_at: null,
    deadline_at: D,
    rrule: null,
    repeat_anchor: null,
    target_days_before: null,
    target_time: null,
    lead_days: null,
    lead_from: '2026-10-27',
  }
  const none = { deadline: undefined, leadDays: undefined }

  test('the stored lead day, and its words', () => {
    const line = leadLine(base, none, TZ, null, NOW)!
    expect(line).toMatchObject({ from: '2026-10-27', daysBefore: 3, leadDays: 3, override: null })
    expect(line.deferredTo).toBeNull()
    expect(line.staged).toBe(false)
    expect(leadLineWords(line, TZ, '2026-10-20')).toBe(
      'On the deadlines page from Tue Oct 27 (3 days before)',
    )
    expect(leadLineWords(line, TZ, '2026-10-27')).toBe(
      'On the deadlines page from today (3 days before)',
    )
    expect(leadLineWords(line, TZ, '2026-10-28')).toBe(
      'On the deadlines page since Tue Oct 27 (3 days before)',
    )
  })

  test('deferred: a stored day after the one derived now is a defer, "deferred to Thu"', () => {
    const line = leadLine({ ...base, lead_from: '2026-10-28' }, none, TZ, null, NOW)!
    expect(line.from).toBe('2026-10-27')
    expect(line.deferredTo).toBe('2026-10-28')
  })

  test('a stored day before the derived one (set from further out) is not a defer', () => {
    // Set 20 days out (4-day lead → Mon Oct 26); now the table gives 3.
    const line = leadLine({ ...base, lead_from: '2026-10-26' }, none, TZ, null, NOW)!
    expect(line).toMatchObject({ from: '2026-10-26', daysBefore: 4, deferredTo: null })
  })

  test('a staged override previews the new day (blue) and drops a deferral', () => {
    const line = leadLine(
      { ...base, lead_from: '2026-10-28' },
      { deadline: undefined, leadDays: 7 },
      TZ,
      null,
      NOW,
    )!
    expect(line).toMatchObject({ from: '2026-10-23', daysBefore: 7, leadDays: 7, override: 7 })
    expect(line.staged).toBe(true)
    expect(line.deferredTo).toBeNull()
  })

  test('a staged deadline re-derives from now; the lead never lands before today', () => {
    // Sat Oct 24 23:59: a 4-day wait → the day before, Fri Oct 23.
    const near = leadLine(
      base,
      { deadline: '2026-10-25T04:59:00.000Z', leadDays: undefined },
      TZ,
      null,
      NOW,
    )!
    expect(near).toMatchObject({ from: '2026-10-23', daysBefore: 1, staged: true })
    // A 30-day override on a deadline 10 days out: from today.
    const clamped = leadLine(
      { ...base, lead_days: 30 },
      { deadline: D, leadDays: 30 },
      TZ,
      null,
      NOW,
    )!
    expect(clamped.from).toBe('2026-10-20')
    // The stepper shows the effective lead (Trent, 10-22): as early as it can be.
    expect(clamped).toMatchObject({ leadDays: 10, clamped: true, override: 30 })
  })

  test('L9: a deadline before the rollover counts on the evening before', () => {
    // Fri Oct 30 00:30 CDT with a 04:00 rollover: its OpenTask day is Thu Oct 29.
    const early = '2026-10-30T05:30:00.000Z'
    const line = leadLine(
      { ...base, deadline_at: early, lead_from: '2026-10-26' },
      none,
      TZ,
      '04:00',
      NOW,
    )!
    expect(line.daysBefore).toBe(3)
  })

  test('none without a deadline, or for a repeat with a relative target', () => {
    expect(leadLine({ ...base, deadline_at: null }, none, TZ, null, NOW)).toBeNull()
    expect(
      leadLine(
        {
          ...base,
          rrule: 'FREQ=WEEKLY;BYDAY=FR',
          repeat_anchor: 'deadline',
          target_days_before: 1,
          target_time: '18:00',
        },
        none,
        TZ,
        null,
        NOW,
      ),
    ).toBeNull()
  })

  test('leadDaysWords', () => {
    expect(leadDaysWords(0)).toBe('the deadline day')
    expect(leadDaysWords(1)).toBe('the day before')
    expect(leadDaysWords(4)).toBe('4 days before')
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
    expect(deadlineRepeatLabel(task)).toBe('target the deadline day at 12:00 PM')
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
    expect(relativeTargetWords(0, '12:00')).toBe('the deadline day at 12:00 PM')
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
