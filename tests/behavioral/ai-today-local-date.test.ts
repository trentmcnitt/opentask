/**
 * AI enrichment — "today" is today's local date (resolveTodayLocalDate,
 * 2026-10-17). The real failure: SDK at 10:57 PM CDT put a "today" task on
 * the next day (the UTC date). Pinned alone and through
 * postProcessTaskDates, the one pipeline production and the quality harness
 * share.
 */

import { describe, test, expect } from 'vitest'
import { resolveTodayLocalDate, postProcessTaskDates } from '@/core/ai/enrichment'
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
// Fri Oct 16 2026, 10:57 PM CDT (= Sat Oct 17, 03:57 UTC).
const NOW = new Date('2026-10-16T22:57:00-05:00')
// The app's placement of a bare "today" at that moment: the top of the next hour.
const TODAY_TARGET = new Date('2026-10-16T23:00:00-05:00').toISOString()
const run = (text: string, due_at: string, extra: Partial<EnrichmentResult> = {}) =>
  resolveTodayLocalDate(result({ due_at, ...extra }), text, TZ, TODAY_TARGET, NOW).due_at

describe('a "today" / "tonight" target on another date moves to today', () => {
  test('"tonight at 11pm" said at 10:57 PM, dated tomorrow → today 11 PM', () => {
    expect(run('call mom tonight at 11pm', '2026-10-17T23:00:00')).toBe('2026-10-16T23:00:00')
  })

  test('the real failure: "today", model gives tomorrow 9 AM → today; 9 AM has passed → the app\'s "today" time', () => {
    expect(run('text Matthew today', '2026-10-17T09:00:00')).toBe('2026-10-16T23:00:00')
  })

  test('"tonight", model gives tomorrow 11:30 PM (still ahead today) → today 11:30 PM', () => {
    expect(run('take out the trash tonight', '2026-10-17T23:30:00')).toBe('2026-10-16T23:30:00')
  })

  test('"tonight" the model put on today at the 10 PM sleep time, said at 10:57 PM → the app\'s "today" time', () => {
    expect(run('take out the trash tonight', '2026-10-16T22:00:00')).toBe('2026-10-16T23:00:00')
  })

  test("a clock time said for today stays that time today, even if passed (the user's words)", () => {
    expect(run('call the bank today at 3pm', '2026-10-17T15:00:00')).toBe('2026-10-16T15:00:00')
  })
})

describe('left alone', () => {
  test('already today and still ahead, or a time the user said (even passed)', () => {
    expect(run('text Matthew today', '2026-10-16T23:00:00')).toBe('2026-10-16T23:00:00')
    expect(run('call mom tonight at 7', '2026-10-16T19:00:00')).toBe('2026-10-16T19:00:00')
  })

  test('another day word beside "today"', () => {
    expect(run('do it today or tomorrow', '2026-10-17T09:00:00')).toBe('2026-10-17T09:00:00')
    expect(run("Tuesday: bring today's meeting notes", '2026-10-20T09:00:00')).toBe(
      '2026-10-20T09:00:00',
    )
    expect(run('today, or next week at the latest', '2026-10-17T09:00:00')).toBe(
      '2026-10-17T09:00:00',
    )
  })

  test('"tonight" / "today" inside a word', () => {
    expect(run('watch Tonights Show highlights', '2026-10-17T09:00:00')).toBe('2026-10-17T09:00:00')
    expect(run('read USA Todays article', '2026-10-17T09:00:00')).toBe('2026-10-17T09:00:00')
  })

  test('repeating tasks (the first-occurrence rules own their dates); null; deadlines', () => {
    expect(
      run('stretch every day starting today', '2026-10-17T09:00:00', { rrule: 'FREQ=DAILY' }),
    ).toBe('2026-10-17T09:00:00')
    expect(resolveTodayLocalDate(result({}), 'today', TZ, TODAY_TARGET, NOW).due_at).toBeNull()
    const out = resolveTodayLocalDate(
      result({ due_at: '2026-10-17T09:00:00', deadline_at: '2026-10-17T23:59:00' }),
      'call the bank today',
      TZ,
      TODAY_TARGET,
      NOW,
    )
    expect(out.deadline_at).toBe('2026-10-17T23:59:00')
  })
})

describe('through postProcessTaskDates (the whole shared post-process)', () => {
  const full = (text: string, overrides: Partial<EnrichmentResult>) =>
    postProcessTaskDates(result(overrides), text, TZ, {
      dayStart: CALENDAR_DAY_START,
      morningTime: '09:00',
      todayTarget: TODAY_TARGET,
      now: NOW,
      newTask: true,
    })
  const pipe = (text: string, overrides: Partial<EnrichmentResult>) => full(text, overrides).due_at
  const deck = (text: string, overrides: Partial<EnrichmentResult>) => {
    const out = full(text, overrides)
    return { due_at: out.due_at, on_deck_day: out.on_deck_day ?? null }
  }

  // On deck (D3, 2026-10-20): "today" with no time is a deck now, not a
  // target. The same late-evening date slip is fixed on the deck day.
  test('the real failure, end to end: "today" dated tomorrow at 10:57 PM → on deck today', () => {
    expect(deck('text Matthew today', { due_at: '2026-10-17T09:00:00' })).toEqual({
      due_at: null,
      on_deck_day: '2026-10-16',
    })
  })

  test('"tonight at 11pm" dated tomorrow → today 11 PM, and no later rule moves it', () => {
    expect(pipe('call mom tonight at 11pm', { due_at: '2026-10-17T23:00:00' })).toBe(
      '2026-10-16T23:00:00',
    )
  })

  test('a date-only "today" the model dated tomorrow → on deck today', () => {
    expect(deck('text Matthew today', { due_at: '2026-10-17' })).toEqual({
      due_at: null,
      on_deck_day: '2026-10-16',
    })
  })

  test('"today or tomorrow" keeps the model\'s tomorrow (on deck)', () => {
    expect(deck('do it today or tomorrow', { due_at: '2026-10-17T09:00:00' })).toEqual({
      due_at: null,
      on_deck_day: '2026-10-17',
    })
  })
})
