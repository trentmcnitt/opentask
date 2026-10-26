/**
 * AI enrichment — same-day fixes (2026-10-16)
 *
 * - resolveSameDayPast: a one-off target the model dated TODAY moves to the
 *   same time tomorrow when the words say "tomorrow", or when its time has
 *   passed and the words name no clock time. Real failure: Haiku, at 7:52 PM
 *   on a Friday, turned "call mom tomorrow evening" into Friday 7:00 PM.
 * - dropNowPhraseTarget: "now that …" / "for now" / "by now" with no other
 *   time words, and a target in the "now" slots → no target. Real failure:
 *   "now that the lease is signed call the landlord" → 7:45 PM, said at 7:38.
 * Both pinned alone and through postProcessTaskDates, the one pipeline
 * production and the quality harness share.
 */

import { describe, test, expect } from 'vitest'
import { resolveSameDayPast, dropNowPhraseTarget, postProcessTaskDates } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

function result(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    title: 'Clean title',
    due_at: null,
    deadline_at: null,
    horizon: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: 'test',
    ...overrides,
  }
}

const TZ = 'America/Chicago'
// Friday Oct 16 2026, Chicago (UTC-5).
const at = (local: string) => new Date(`2026-10-16T${local}:00-05:00`)

describe('resolveSameDayPast', () => {
  const run = (text: string, due_at: string | null, now: string, extra = {}) =>
    resolveSameDayPast(result({ due_at, ...extra }), text, TZ, at(now)).due_at

  test('the real failure: "tomorrow evening" dated today → tomorrow, same time', () => {
    expect(run('call mom tomorrow evening', '2026-10-16T19:00:00', '19:52')).toBe(
      '2026-10-17T19:00:00',
    )
  })

  test('"tomorrow" moves a target today even when it is still ahead', () => {
    expect(run('dentist tomorrow at 3pm', '2026-10-16T15:00:00', '10:00')).toBe(
      '2026-10-17T15:00:00',
    )
    expect(run('pick up the cake tmrw', '2026-10-16T09:00:00', '08:00')).toBe('2026-10-17T09:00:00')
  })

  test("a part of day that has passed today → tomorrow at the model's time", () => {
    expect(run('call mom in the evening', '2026-10-16T19:00:00', '19:52')).toBe(
      '2026-10-17T19:00:00',
    )
    expect(run('water the plants after lunch', '2026-10-16T13:00:00', '16:00')).toBe(
      '2026-10-17T13:00:00',
    )
  })

  test('a time today still ahead, with no "tomorrow", stays', () => {
    expect(run('call mom in the evening', '2026-10-16T19:00:00', '15:00')).toBe(
      '2026-10-16T19:00:00',
    )
  })

  test('negative: a clock time in the words is the bare-time rule\'s ("tonight at 7" at 8 PM)', () => {
    expect(run('call mom at 7', '2026-10-16T19:00:00', '20:00')).toBe('2026-10-16T19:00:00')
    expect(run('call mom 7pm', '2026-10-16T19:00:00', '20:00')).toBe('2026-10-16T19:00:00')
  })

  test('negative: words that say today, tonight or now', () => {
    expect(run('call mom tonight at 7', '2026-10-16T19:00:00', '20:00')).toBe('2026-10-16T19:00:00')
    expect(run('call mom this evening', '2026-10-16T19:00:00', '20:00')).toBe('2026-10-16T19:00:00')
    expect(run('send it today, follow up tomorrow', '2026-10-16T17:00:00', '12:00')).toBe(
      '2026-10-16T17:00:00',
    )
  })

  test('negative: "tomorrow" inside a word ("Tomorrowland tickets")', () => {
    expect(run('buy Tomorrowland tickets', '2026-10-16T21:00:00', '20:00')).toBe(
      '2026-10-16T21:00:00',
    )
  })

  test('negative: repeating tasks, other days, null; deadlines never touched', () => {
    expect(
      run('stretch tomorrow evening', '2026-10-16T19:00:00', '19:52', { rrule: 'FREQ=DAILY' }),
    ).toBe('2026-10-16T19:00:00')
    expect(run('call mom tomorrow evening', '2026-10-17T19:00:00', '19:52')).toBe(
      '2026-10-17T19:00:00',
    )
    expect(run('call mom tomorrow evening', null, '19:52')).toBeNull()
    const out = resolveSameDayPast(
      result({ due_at: null, deadline_at: '2026-10-16T17:00:00' }),
      'file it by tomorrow',
      TZ,
      at('19:52'),
    )
    expect(out.deadline_at).toBe('2026-10-16T17:00:00')
  })
})

describe('dropNowPhraseTarget', () => {
  const run = (text: string, due_at: string | null, now: string, extra = {}) =>
    dropNowPhraseTarget(result({ due_at, ...extra }), text, TZ, at(now)).due_at

  test('the real failure: "now that the lease is signed" → 7:45 at 7:38 → no target', () => {
    expect(
      run('now that the lease is signed call the landlord', '2026-10-16T19:45:00', '19:38'),
    ).toBeNull()
  })

  test('every "now" slot counts: the quarter now is in, up to the soon slot', () => {
    const text = 'now that the lease is signed call the landlord'
    for (const slot of ['19:30', '19:38', '19:45', '20:00']) {
      expect(run(text, `2026-10-16T${slot}:00`, '19:38'), slot).toBeNull()
    }
    expect(run('leave the boxes in the garage for now', '2026-10-16T19:45:00', '19:38')).toBeNull()
    expect(
      run('the refund should be in by now, check the bank', '2026-10-16T20:00:00', '19:38'),
    ).toBeNull()
  })

  test('a target outside the "now" slots is the model\'s own reading: kept', () => {
    const text = 'now that the lease is signed call the landlord'
    expect(run(text, '2026-10-16T20:15:00', '19:38')).toBe('2026-10-16T20:15:00')
    expect(run(text, '2026-10-17T09:00:00', '19:38')).toBe('2026-10-17T09:00:00')
    expect(run(text, '2026-10-16T19:15:00', '19:38')).toBe('2026-10-16T19:15:00')
  })

  test('negative: other time words alongside ("for now" with "on Friday", a clock, "right now")', () => {
    expect(run('for now park it, revisit on Friday', '2026-10-16T19:45:00', '19:38')).toBe(
      '2026-10-16T19:45:00',
    )
    expect(
      run('now that the lease is signed call the landlord at 8pm', '2026-10-16T20:00:00', '19:38'),
    ).toBe('2026-10-16T20:00:00')
    expect(
      run('now that it is signed, call the landlord right now', '2026-10-16T20:00:00', '19:38'),
    ).toBe('2026-10-16T20:00:00')
    expect(run('for now, call them tonight', '2026-10-16T19:45:00', '19:38')).toBe(
      '2026-10-16T19:45:00',
    )
  })

  test('negative: no phrase, a repeating task', () => {
    expect(run('call the landlord', '2026-10-16T19:45:00', '19:38')).toBe('2026-10-16T19:45:00')
    expect(run('stretch for now', '2026-10-16T19:45:00', '19:38', { rrule: 'FREQ=DAILY' })).toBe(
      '2026-10-16T19:45:00',
    )
  })
})

describe('through postProcessTaskDates', () => {
  const run = (text: string, overrides: Partial<EnrichmentResult>, now: string) =>
    postProcessTaskDates(result(overrides), text, TZ, {
      dayStart: CALENDAR_DAY_START,
      morningTime: '09:00',
      todayTarget: '2026-10-17T01:30:00.000Z',
      now: at(now),
    })

  test('both real failures', () => {
    expect(
      run('call mom tomorrow evening', { due_at: '2026-10-16T19:00:00' }, '19:52').due_at,
    ).toBe('2026-10-17T19:00:00')
    expect(
      run(
        'now that the lease is signed call the landlord',
        { due_at: '2026-10-16T19:45:00' },
        '19:38',
      ).due_at,
    ).toBeNull()
  })

  test('a "now that" target at 7:30 (past) is dropped, not moved to tomorrow', () => {
    expect(
      run(
        'now that the lease is signed call the landlord',
        { due_at: '2026-10-16T19:30:00' },
        '19:38',
      ).due_at,
    ).toBeNull()
  })

  test('"7pm" said at 8 PM still goes to tomorrow by the bare-time rule', () => {
    expect(run('call mom 7pm', { due_at: '2026-10-16T19:00:00' }, '20:00').due_at).toBe(
      '2026-10-17T19:00:00',
    )
  })

  test('"right now" is still the soon slot, untouched by both', () => {
    expect(
      run('call the landlord right now', { due_at: '2026-10-16T19:38:00' }, '19:38').due_at,
    ).toBe('2026-10-16T20:00:00')
  })
})
