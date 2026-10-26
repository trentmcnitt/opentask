/**
 * ON DECK FROM ENRICHMENT (D3, 2026-10-20; spec rule 11, red team A1/A4/A5,
 * B12). A day with no time — "do it Saturday", "today", "tomorrow" — puts the
 * task on deck for that day; a clock time or a part of day is a target, as
 * before; a deadline in the result keeps the picked target (A1).
 *
 * Pinned in two layers:
 * - the pure post-process (`resolveDeckDay`, through `postProcessTaskDates`,
 *   the pipeline production and the quality harness share): which answers
 *   deck, which day, and the code floor for the old default-time answer;
 * - the write (`enrichSingleTask` with the model mocked): the deck is written
 *   with `target_set_at`, a picked target is dropped, the queue switch, a
 *   repeating task and a deadline already on the task turn it back into the
 *   target, the toast/notification words, and undo.
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: vi.fn(),
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { executeUndo } from '@/core/undo'
import { deckTasks } from '@/core/tasks/deck'
import {
  enrichSingleTask,
  postProcessTaskDates,
  deckDayAsTarget,
  deckOrTarget,
  saidTomorrowBeforeRollover,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import type { EnrichmentResult, TaskSummary } from '@/core/ai/types'
import { formatTaskLine } from '@/core/ai/format'
import { buildTaskStats, formatCompactTaskList } from '@/core/ai/quick-take'
import { buildEnrichedNotificationContent } from '@/core/notifications/enrichment-notify'
import { DateTime } from 'luxon'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)
const TZ = 'America/Chicago'

function result(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    reasoning: 'test',
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
    ...overrides,
  }
}

// Tue Oct 20 2026, 2:00 PM CDT.
const TUE_2PM = new Date('2026-10-20T14:00:00-05:00')
const TODAY_TARGET = new Date('2026-10-20T15:00:00-05:00').toISOString()

function pipe(
  text: string,
  overrides: Partial<EnrichmentResult>,
  opts: { now?: Date; rolloverTime?: string; checkInDay?: 6 | 7; morningTime?: string } = {},
) {
  const out = postProcessTaskDates(result(overrides), text, TZ, {
    morningTime: opts.morningTime ?? '09:00',
    todayTarget: TODAY_TARGET,
    rolloverTime: opts.rolloverTime ?? '06:30',
    dayStart: opts.rolloverTime ?? '06:30',
    checkInDay: opts.checkInDay,
    now: opts.now ?? TUE_2PM,
    newTask: true,
  })
  return { due_at: out.due_at, on_deck_day: out.on_deck_day ?? null }
}

const deck = (day: string) => ({ due_at: null, on_deck_day: day })
const target = (at: string) => ({ due_at: at, on_deck_day: null })
const NONE = { due_at: null, on_deck_day: null }

describe('a day with no time goes on deck (the post-process)', () => {
  test('bare "tomorrow", "Saturday", "today" → on deck that day, no target', () => {
    expect(pipe('call mom tomorrow', { due_at: '2026-10-21' })).toEqual(deck('2026-10-21'))
    expect(pipe('do it Saturday', { due_at: '2026-10-24' })).toEqual(deck('2026-10-24'))
    expect(pipe('text Matthew today', { due_at: '2026-10-20' })).toEqual(deck('2026-10-20'))
    expect(pipe('return the drill in 3 days', { due_at: '2026-10-23' })).toEqual(deck('2026-10-23'))
  })

  test('B12 floor: the old default-time answer for a day with no time → on deck', () => {
    expect(pipe('call mom tomorrow', { due_at: '2026-10-21T09:00:00' })).toEqual(deck('2026-10-21'))
    expect(pipe('grab gloves Friday', { due_at: '2026-10-23T09:00:00' })).toEqual(
      deck('2026-10-23'),
    )
  })

  test("the floor needs exactly the default time: another time is the model's reading", () => {
    expect(
      pipe('call mom tomorrow', { due_at: '2026-10-21T09:00:00' }, { morningTime: '08:00' }),
    ).toEqual(target('2026-10-21T09:00:00'))
  })

  test('A5: a part of day stays a target — "tomorrow morning", "tonight", "this evening"', () => {
    expect(pipe('call the dentist tomorrow morning', { due_at: '2026-10-21T09:00:00' })).toEqual(
      target('2026-10-21T09:00:00'),
    )
    expect(pipe('take out the trash tonight', { due_at: '2026-10-20T22:00:00' })).toEqual(
      target('2026-10-20T22:00:00'),
    )
    expect(pipe('call mom this evening', { due_at: '2026-10-20T18:00:00' })).toEqual(
      target('2026-10-20T18:00:00'),
    )
    expect(pipe('Saturday first thing, mow the lawn', { due_at: '2026-10-24T09:00:00' })).toEqual(
      target('2026-10-24T09:00:00'),
    )
  })

  test('a stated clock time stays a target, even at the default time', () => {
    expect(pipe('call mom tomorrow at 9am', { due_at: '2026-10-21T09:00:00' })).toEqual(
      target('2026-10-21T09:00:00'),
    )
    expect(pipe('order books at noon', { due_at: '2026-10-20T12:00:00' })).toEqual(
      target('2026-10-21T12:00:00'),
    )
  })

  test('A1: a deadline in the result keeps the picked target ("by Friday, do it Wednesday")', () => {
    expect(
      pipe('cancel it by Friday, do it Wednesday', {
        due_at: '2026-10-21',
        deadline_at: '2026-10-23T23:59:00',
      }),
    ).toEqual(target('2026-10-21T09:00:00'))
    // The floor's answer is already the target.
    expect(
      pipe('cancel it by Friday, do it Wednesday', {
        due_at: '2026-10-21T09:00:00',
        deadline_at: '2026-10-23T23:59:00',
      }),
    ).toEqual(target('2026-10-21T09:00:00'))
  })

  test('a repeating task is never decked ("every Saturday")', () => {
    const out = postProcessTaskDates(
      result({ due_at: '2026-10-24', rrule: 'FREQ=WEEKLY;BYDAY=SA' }),
      'mow the lawn every Saturday',
      TZ,
      {
        morningTime: '09:00',
        todayTarget: TODAY_TARGET,
        dayStart: CALENDAR_DAY_START,
        now: TUE_2PM,
        newTask: true,
      },
    )
    expect(out.on_deck_day ?? null).toBeNull()
    expect(out.due_at).toBe('2026-10-24T09:00:00')
  })

  test('a day the words never name is dropped — no deck and no target', () => {
    expect(pipe('check the mail', { due_at: '2026-10-20' })).toEqual(NONE)
    expect(pipe('check the mail', { due_at: '2026-10-22' })).toEqual(NONE)
    // "this" / "next" are in DAY_NAMED, but they never license TODAY.
    expect(pipe('call the bank about this', { due_at: '2026-10-20' })).toEqual(NONE)
  })

  test('today\'s weekday names today: "do it Tuesday" said on a Tuesday', () => {
    expect(pipe('do it Tuesday', { due_at: '2026-10-20' })).toEqual(deck('2026-10-20'))
  })

  test('a past day the words do not state is dropped by the past-date guard', () => {
    expect(pipe('call mom', { due_at: '2026-10-19' })).toEqual(NONE)
  })

  test('"today" dated another day (the late-evening UTC slip) → on deck today', () => {
    expect(pipe('text Matthew today', { due_at: '2026-10-21' })).toEqual(deck('2026-10-20'))
  })

  test('"tomorrow" dated today after the rollover → tomorrow', () => {
    expect(pipe('call mom tomorrow', { due_at: '2026-10-20' })).toEqual(deck('2026-10-21'))
  })
})

describe('A4: "tomorrow" said between midnight and the rollover is the coming day', () => {
  // Wed Oct 21 2026, 00:30 CDT — still Tuesday's OpenTask day (rollover 6:30).
  const AT_0030 = new Date('2026-10-21T00:30:00-05:00')
  // Tue Oct 20 2026, 23:30 CDT.
  const AT_2330 = new Date('2026-10-20T23:30:00-05:00')

  test('at 00:30: "tomorrow" → the calendar today, whichever the model wrote', () => {
    expect(pipe('call mom tomorrow', { due_at: '2026-10-22' }, { now: AT_0030 })).toEqual(
      deck('2026-10-21'),
    )
    expect(pipe('call mom tomorrow', { due_at: '2026-10-21' }, { now: AT_0030 })).toEqual(
      deck('2026-10-21'),
    )
    expect(pipe('call mom tomorrow', { due_at: '2026-10-22T09:00:00' }, { now: AT_0030 })).toEqual(
      deck('2026-10-21'),
    )
  })

  test('at 23:30: "tomorrow" → the calendar tomorrow', () => {
    expect(pipe('call mom tomorrow', { due_at: '2026-10-21' }, { now: AT_2330 })).toEqual(
      deck('2026-10-21'),
    )
  })

  test('after the rollover (07:00), "tomorrow" is the next calendar day', () => {
    const AT_0700 = new Date('2026-10-21T07:00:00-05:00')
    expect(pipe('call mom tomorrow', { due_at: '2026-10-22' }, { now: AT_0700 })).toEqual(
      deck('2026-10-22'),
    )
  })

  test('A4 for targets too: "tomorrow at 3pm" at 00:30 → the calendar today, 3 PM', () => {
    // The model reads the calendar: Wednesday. Or already Tuesday: kept.
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-22T15:00:00' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-21T15:00:00'))
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-21T15:00:00' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-21T15:00:00'))
  })

  test('A4 for targets: "tomorrow morning" at 00:30 → this morning', () => {
    expect(
      pipe('call the vet tomorrow morning', { due_at: '2026-10-22T09:00:00' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-21T09:00:00'))
  })

  test('"tomorrow at 3pm" at 23:30 → the next calendar day, 3 PM', () => {
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-21T15:00:00' }, { now: AT_2330 }),
    ).toEqual(target('2026-10-21T15:00:00'))
  })

  test('after the rollover (07:00), "tomorrow at 3pm" is the next calendar day', () => {
    const AT_0700 = new Date('2026-10-21T07:00:00-05:00')
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-22T15:00:00' }, { now: AT_0700 }),
    ).toEqual(target('2026-10-22T15:00:00'))
  })

  test('A4 never moves a target into the past: "tomorrow at 12:15am" at 00:30 stays', () => {
    expect(
      pipe('call mom tomorrow at 12:15am', { due_at: '2026-10-22T00:15:00' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-22T00:15:00'))
  })

  test('one window for both: the helper and the deck agree at the rollover minute', () => {
    const AT_0629 = new Date('2026-10-21T06:29:00-05:00')
    const AT_0630 = new Date('2026-10-21T06:30:00-05:00')
    expect(saidTomorrowBeforeRollover('call mom tomorrow', TZ, '06:30', AT_0629)).toBe(true)
    expect(saidTomorrowBeforeRollover('call mom tomorrow', TZ, '06:30', AT_0630)).toBe(false)
    expect(saidTomorrowBeforeRollover('call mom', TZ, '06:30', AT_0629)).toBe(false)
    expect(pipe('call mom tomorrow', { due_at: '2026-10-22' }, { now: AT_0629 })).toEqual(
      deck('2026-10-21'),
    )
    expect(pipe('call mom tomorrow', { due_at: '2026-10-22' }, { now: AT_0630 })).toEqual(
      deck('2026-10-22'),
    )
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-22T15:00:00' }, { now: AT_0629 }),
    ).toEqual(target('2026-10-21T15:00:00'))
    expect(
      pipe('call mom tomorrow at 3pm', { due_at: '2026-10-22T15:00:00' }, { now: AT_0630 }),
    ).toEqual(target('2026-10-22T15:00:00'))
  })
})

describe('"this weekend" (A5)', () => {
  test('a bare "this weekend" decks the check-in Saturday', () => {
    expect(pipe('clean the garage this weekend', { due_at: '2026-10-24' })).toEqual(
      deck('2026-10-24'),
    )
    // The model's Sunday too: the check-in day decides.
    expect(pipe('clean the garage this weekend', { due_at: '2026-10-25' })).toEqual(
      deck('2026-10-24'),
    )
  })

  test('a Sunday check-in day decks Sunday', () => {
    expect(
      pipe('clean the garage this weekend', { due_at: '2026-10-24' }, { checkInDay: 7 }),
    ).toEqual(deck('2026-10-25'))
  })

  test('said on a Saturday, "this weekend" is today', () => {
    const SAT = new Date('2026-10-24T10:00:00-05:00')
    expect(pipe('clean the garage this weekend', { due_at: '2026-10-24' }, { now: SAT })).toEqual(
      deck('2026-10-24'),
    )
  })

  test('"sometime this weekend" is a pace (horizon days), never a deck', () => {
    const out = postProcessTaskDates(
      result({ horizon: 'days' }),
      'sometime this weekend clean the garage',
      TZ,
      {
        morningTime: '09:00',
        todayTarget: TODAY_TARGET,
        dayStart: CALENDAR_DAY_START,
        now: TUE_2PM,
        newTask: true,
      },
    )
    expect(out.on_deck_day ?? null).toBeNull()
    expect(out.due_at).toBeNull()
    expect(out.horizon).toBe('days')
  })
})

describe('D3 review: the floor never decks a time the user said', () => {
  // Thursday Oct 22, the model at the default time (9:00).
  const THU_9 = '2026-10-22T09:00:00'
  test.each([
    'call mom Thursday 9',
    'call mom Thursday 9:00',
    'call mom Thursday at nine',
    "call mom Thursday 9 o'clock",
    'call mom around 9 Thursday',
    'call mom Thursday @ 9',
    'call mom Thursday 0900',
    'call mom Thursday 9a',
    'call mom Thursday 9 a m',
    'call mom Thursday in the AM',
    'call mom Thursday nine-ish',
  ])('%s → the target stays', (text) => {
    expect(pipe(text, { due_at: THU_9 })).toEqual(target(THU_9))
  })

  test('"in 30 minutes" is never a day', () => {
    expect(pipe('call mom in 30 minutes', { due_at: '2026-10-20T14:30:00' }).on_deck_day).toBeNull()
    expect(pipe('call mom in 30 minutes', { due_at: '2026-10-20' }).on_deck_day).toBeNull()
  })

  test('numbers that are part of the day still deck: "in 3 days", "Oct 24", "the 24th"', () => {
    expect(pipe('return the drill in 3 days', { due_at: '2026-10-23T09:00:00' })).toEqual(
      deck('2026-10-23'),
    )
    expect(pipe('return the drill Oct 24', { due_at: '2026-10-24T09:00:00' })).toEqual(
      deck('2026-10-24'),
    )
    expect(pipe('return the drill on the 24th', { due_at: '2026-10-24T09:00:00' })).toEqual(
      deck('2026-10-24'),
    )
  })
})

describe('D3 review: a bare date from words that say a time is a target', () => {
  test.each([
    ['call the vet tomorrow morning', '2026-10-21'],
    ['call grandma Friday evening', '2026-10-23'],
    ['mow the lawn Saturday at 3pm', '2026-10-24'],
  ])('%s (bare %s) → a target, not a deck', (text, bare) => {
    const out = pipe(text, { due_at: bare })
    expect(out.on_deck_day).toBeNull()
    expect(out.due_at).toMatch(new RegExp(`^${bare}T`))
  })
})

describe('D3 review: misspelled "tomorrow"', () => {
  const AT_0030 = new Date('2026-10-21T00:30:00-05:00')
  test('"tommorow" at 00:30 → on deck the coming day (calendar today), never dropped', () => {
    expect(pipe('call mom tommorow', { due_at: '2026-10-22' }, { now: AT_0030 })).toEqual(
      deck('2026-10-21'),
    )
    expect(pipe('call mom tommorow', { due_at: '2026-10-21' }, { now: AT_0030 })).toEqual(
      deck('2026-10-21'),
    )
  })
  test('"tomorow" dated today after the rollover → tomorrow', () => {
    expect(pipe('call mom tomorow', { due_at: '2026-10-20' })).toEqual(deck('2026-10-21'))
  })
  test('"Tomorrowland" is not "tomorrow"', () => {
    expect(pipe('buy Tomorrowland tickets', { due_at: '2026-10-20' })).toEqual(NONE)
  })
})

describe('D3 review: "this weekend" beside a named weekday keeps the weekday', () => {
  test('"plan Sunday brunch this weekend" → on deck Sunday', () => {
    expect(pipe('plan Sunday brunch this weekend', { due_at: '2026-10-25' })).toEqual(
      deck('2026-10-25'),
    )
    // The model's Saturday too: the named day wins.
    expect(pipe('plan Sunday brunch this weekend', { due_at: '2026-10-24' })).toEqual(
      deck('2026-10-25'),
    )
    // Another weekday named: the model's day stands.
    expect(pipe('this weekend or Friday, wash the car', { due_at: '2026-10-23' })).toEqual(
      deck('2026-10-23'),
    )
  })
})

describe('D3 ruling: a deadline follows A4 too', () => {
  test('"by tomorrow" at 00:30 → the deadline is the calendar today', () => {
    const AT_0030 = new Date('2026-10-21T00:30:00-05:00')
    const out = postProcessTaskDates(
      result({ deadline_at: '2026-10-22T23:59:00' }),
      'send the permit form by tomorrow',
      TZ,
      {
        morningTime: '09:00',
        todayTarget: TODAY_TARGET,
        rolloverTime: '06:30',
        dayStart: '06:30',
        now: AT_0030,
        newTask: true,
      },
    )
    expect(out.deadline_at).toBe('2026-10-21T23:59:00')
  })
})

describe('D3 ruling: a deck never lands in the past', () => {
  test('"do it Tuesday" said Tuesday night, answered just after midnight → on deck Wednesday', () => {
    const WED_0001 = new Date('2026-10-21T00:00:30-05:00')
    expect(pipe('do it Tuesday', { due_at: '2026-10-20' }, { now: WED_0001 })).toEqual(
      deck('2026-10-21'),
    )
  })
})

describe('D3 ruling: "remind me <day>" is a target at the default time', () => {
  test('"remind me Monday to call the bank" → Monday 9:00 (bare or timed answer)', () => {
    expect(pipe('remind me Monday to call the bank', { due_at: '2026-10-26' })).toEqual(
      target('2026-10-26T09:00:00'),
    )
    expect(pipe('remind me Monday to call the bank', { due_at: '2026-10-26T09:00:00' })).toEqual(
      target('2026-10-26T09:00:00'),
    )
  })
  test('"remind me tomorrow" → tomorrow 9:00; at 00:30, the calendar today (A4)', () => {
    expect(pipe('remind me tomorrow to call the bank', { due_at: '2026-10-21' })).toEqual(
      target('2026-10-21T09:00:00'),
    )
    const AT_0030 = new Date('2026-10-21T00:30:00-05:00')
    expect(
      pipe('remind me tomorrow to call the bank', { due_at: '2026-10-22' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-21T09:00:00'))
  })
  test('"call the bank Monday" still decks', () => {
    expect(pipe('call the bank Monday', { due_at: '2026-10-26' })).toEqual(deck('2026-10-26'))
  })
})

describe('"nag me <day>" is a target at the default time, like "remind me" (2026-10-22)', () => {
  test('"nag me Monday about the invoice" → Monday 9:00 (bare or timed answer)', () => {
    expect(pipe('nag me Monday about the invoice', { due_at: '2026-10-26' })).toEqual(
      target('2026-10-26T09:00:00'),
    )
    expect(pipe('nag me Monday about the invoice', { due_at: '2026-10-26T09:00:00' })).toEqual(
      target('2026-10-26T09:00:00'),
    )
  })
  test('"nag me on Friday" and "nag me next Monday" → that day at 9:00', () => {
    expect(pipe('nag me on Friday to send the invoice', { due_at: '2026-10-23' })).toEqual(
      target('2026-10-23T09:00:00'),
    )
    expect(pipe('Nag me next Monday about the lease', { due_at: '2026-10-26' })).toEqual(
      target('2026-10-26T09:00:00'),
    )
  })
  test('"nag me tomorrow" at 00:30 → the calendar today at 9:00 (A4)', () => {
    const AT_0030 = new Date('2026-10-21T00:30:00-05:00')
    expect(
      pipe('nag me tomorrow about the invoice', { due_at: '2026-10-22' }, { now: AT_0030 }),
    ).toEqual(target('2026-10-21T09:00:00'))
  })
  test('"don\'t nag me" asks for no nag: a bare day beside it still decks', () => {
    expect(pipe("call the bank Thursday, don't nag me", { due_at: '2026-10-22' })).toEqual(
      deck('2026-10-22'),
    )
    expect(pipe('call the bank Thursday, don’t nag me', { due_at: '2026-10-22' })).toEqual(
      deck('2026-10-22'),
    )
    expect(pipe('do not nag me, call the bank Thursday', { due_at: '2026-10-22' })).toEqual(
      deck('2026-10-22'),
    )
  })
  test('"nag me every <interval>" is the nag interval, not a day cue: the bare day decks', () => {
    expect(
      pipe('call Dave Thursday, nag me every 30 minutes', {
        due_at: '2026-10-22',
        auto_snooze_minutes: 30,
      }),
    ).toEqual(deck('2026-10-22'))
  })
  test('nagging someone else is the task: "nag Dave Monday" still decks', () => {
    expect(pipe('nag Dave Monday about the invoice', { due_at: '2026-10-26' })).toEqual(
      deck('2026-10-26'),
    )
  })
})

describe('deckDayAsTarget (the fallback when the deck cannot be written)', () => {
  test('today → the "Target today" time; another day → the default task time', () => {
    expect(
      deckDayAsTarget('2026-10-20', TZ, '09:00', TODAY_TARGET, CALENDAR_DAY_START, TUE_2PM),
    ).toBe(TODAY_TARGET)
    expect(
      deckDayAsTarget('2026-10-24', TZ, '09:00', TODAY_TARGET, CALENDAR_DAY_START, TUE_2PM),
    ).toBe('2026-10-24T14:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function modelAnswer(overrides: Partial<EnrichmentResult>) {
  return { structuredOutput: { ...result(overrides) }, text: null, durationMs: 50 }
}

function titleOnly(title: string) {
  return createTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, input: { title } })
}

describe('the enrichment write', () => {
  beforeAll(() => {
    setupTestDb()
    getDb().prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
  })
  afterAll(() => teardownTestDb())

  beforeEach(() => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    // Tue Oct 20 2026, 2 PM CDT
    vi.setSystemTime(TUE_2PM)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    mockEnrichmentQuery.mockReset()
    _resetCircuitBreaker()
    _resetProcessingState()
  })

  test('"do it Saturday" → on deck Saturday, no target, target_set_at stamped', async () => {
    const task = titleOnly('do it Saturday: grab winter gloves')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Grab winter gloves', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBe('2026-10-24')
    expect(after.due_at).toBeNull()
    expect(after.target_auto).toBe(false)
    expect(after.target_set_at).toBe(TUE_2PM.toISOString())
    // The user hasn't seen it: no "considered" stamp, no Just now card.
    expect(after.last_considered_at ?? null).toBeNull()
    expect(after.segment_targeted_at ?? null).toBeNull()
  })

  test('the floor answer ("tomorrow" at the default time) is written as a deck too', async () => {
    const task = titleOnly('call mom tomorrow')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Call mom', due_at: '2026-10-21T09:00:00' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBe('2026-10-21')
    expect(after.due_at).toBeNull()
  })

  test('a time keeps targeting: "call mom tomorrow morning" → 9 AM target, no deck', async () => {
    const task = titleOnly('call mom tomorrow morning')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Call mom', due_at: '2026-10-21T09:00:00' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBeNull()
    expect(after.due_at).toBe('2026-10-21T14:00:00.000Z')
  })

  test('the queue switch off: the deck is the target it was before D3', async () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    const task = titleOnly('do it Saturday: grab gloves')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Grab gloves', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBeNull()
    expect(after.due_at).toBe('2026-10-24T14:00:00.000Z')
  })

  test('A1: a deadline already on the task keeps the picked target (re-enrichment)', async () => {
    const task = titleOnly('renew the passport')
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { deadline_at: '2026-11-20T05:59:00.000Z' },
    })
    getDb()
      .prepare(`UPDATE tasks SET labels = '["ai-to-process"]', original_title = ? WHERE id = ?`)
      .run('renew the passport, do it Saturday', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Renew the passport', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBeNull()
    expect(after.due_at).toBe('2026-10-24T14:00:00.000Z')
    expect(after.target_auto).toBe(false)
  })

  test('re-enrichment decking a task with a picked target drops the target (never both)', async () => {
    const task = titleOnly('water the plants')
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: '2026-10-22T20:00:00.000Z' },
    })
    getDb()
      .prepare(`UPDATE tasks SET labels = '["ai-to-process"]', original_title = ? WHERE id = ?`)
      .run('water the plants Saturday', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Water the plants', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBe('2026-10-24')
    expect(after.due_at).toBeNull()

    // Undo puts the picked target back and takes the deck off.
    executeUndo(TEST_USER_ID)
    const undone = getTaskById(task.id)!
    expect(undone.on_deck_day).toBeNull()
    expect(undone.due_at).toBe('2026-10-22T20:00:00.000Z')
  })

  test('a repeating answer is never decked', async () => {
    const task = titleOnly('mow the lawn every Saturday')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Mow the lawn', due_at: '2026-10-24', rrule: 'FREQ=WEEKLY;BYDAY=SA' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBeNull()
    expect(after.rrule).toContain('BYDAY=SA')
    expect(after.due_at).not.toBeNull()
  })

  test('a repeating TASK re-enriched with a day is never decked by the AI (a target, as before D3)', async () => {
    // Repeating tasks can be decked by the user (2026-10-20), never by the AI:
    // a deck beside the rule's date would be a deck plus a picked target.
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'mow the lawn', rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0' },
    })
    getDb()
      .prepare(`UPDATE tasks SET labels = '["ai-to-process"]', original_title = ? WHERE id = ?`)
      .run('mow the lawn, do it Saturday', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Mow the lawn', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBeNull()
    expect(after.due_at).not.toBeNull()
  })

  test('re-enriching a repeating task ON DECK leaves the deck, the occurrence and every date alone', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'water the ferns', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
    })
    deckTasks({ userId: TEST_USER_ID, timezone: TEST_TIMEZONE, ids: [task.id], day: '2026-10-21' })
    const decked = getTaskById(task.id)!
    expect(decked).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
    getDb()
      .prepare(`UPDATE tasks SET labels = '["ai-to-process"]', original_title = ? WHERE id = ?`)
      .run('water the ferns every Friday, Saturday', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Water the ferns',
        due_at: '2026-10-24',
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
      }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.title).toBe('Water the ferns')
    expect(after).toMatchObject({
      on_deck_day: '2026-10-21',
      due_at: null,
      occurrence_at: decked.occurrence_at,
      rrule: decked.rrule,
    })
  })

  test('race: the user decks while the model answers a timed target → the user wins', async () => {
    const task = titleOnly('call mom tomorrow at 3pm')
    mockEnrichmentQuery.mockImplementationOnce(async () => {
      deckTasks({
        userId: TEST_USER_ID,
        timezone: TEST_TIMEZONE,
        ids: [task.id],
        day: '2026-10-23',
      })
      return modelAnswer({ title: 'Call mom', due_at: '2026-10-21T15:00:00' })
    })
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.on_deck_day).toBe('2026-10-23')
    expect(after.due_at).toBeNull()
    // A manual edit cancels the enrichment: nothing of the answer lands.
    expect(after.title).toBe('call mom tomorrow at 3pm')
  })

  test('race: the user decks while the model answers another deck day → the user wins', async () => {
    const task = titleOnly('call mom Saturday')
    mockEnrichmentQuery.mockImplementationOnce(async () => {
      deckTasks({
        userId: TEST_USER_ID,
        timezone: TEST_TIMEZONE,
        ids: [task.id],
        day: '2026-10-21',
      })
      return modelAnswer({ title: 'Call mom', due_at: '2026-10-24' })
    })
    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.on_deck_day).toBe('2026-10-21')
  })

  test('race: the date moves under the model (label kept) → only the date fields are dropped', async () => {
    const task = titleOnly('call mom saturday high priority')
    mockEnrichmentQuery.mockImplementationOnce(async () => {
      getDb()
        .prepare('UPDATE tasks SET due_at = ? WHERE id = ?')
        .run('2026-10-22T20:00:00.000Z', task.id)
      return modelAnswer({ title: 'Call mom', due_at: '2026-10-24', priority: 3 })
    })
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.due_at).toBe('2026-10-22T20:00:00.000Z')
    expect(after.on_deck_day).toBeNull()
    expect(after.title).toBe('Call mom')
    expect(after.priority).toBe(3)
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('a deck day that ended while the model ran is decked for today, never the past', () => {
    const task = titleOnly('do it Tuesday')
    const out = deckOrTarget(
      getTaskById(task.id)!,
      result({ on_deck_day: '2026-10-19' }),
      { id: TEST_USER_ID, timezone: TEST_TIMEZONE },
      TUE_2PM,
    )
    expect(out.on_deck_day).toBe('2026-10-20')
    expect(out.due_at).toBeNull()
  })

  test('the notification body says "On deck <day>"', async () => {
    const task = titleOnly('do it Saturday: grab gloves')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Grab gloves', due_at: '2026-10-24' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const { body } = buildEnrichedNotificationContent({
      task: getTaskById(task.id)!,
      projectName: 'Inbox',
      timezone: TEST_TIMEZONE,
      dayStart: CALENDAR_DAY_START,
      slots: [],
    })
    expect(body).toBe('Added to Inbox · On deck Sat Oct 24')
  })
})

// ---------------------------------------------------------------------------
// AI consumers (B11)
// ---------------------------------------------------------------------------

describe('AI consumers read a deck as a plan', () => {
  const summary: TaskSummary = {
    id: 7,
    title: 'Grab winter gloves',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: '2026-09-01T15:00:00.000Z',
    labels: [],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
    on_deck_day: '2026-10-24',
  }
  const now = DateTime.fromJSDate(TUE_2PM).setZone(TZ)

  test('formatTaskLine prints "on deck: Sat, Oct 24", not "target: none"', () => {
    const line = formatTaskLine(summary, TZ, now)
    expect(line).toContain('| on deck: Sat, Oct 24 |')
    expect(line).not.toContain('target: none')
  })

  test('quick-take: a deck is not undated, and the compact line says deck:', () => {
    const tasks = [
      { title: 'Gloves', on_deck_day: '2026-10-24', priority: 0 },
      { title: 'Mail', priority: 0 },
    ]
    const stats = buildTaskStats(tasks, TZ)
    expect(stats.undated).toBe(1)
    expect(stats.onDeck).toBe(1)
    expect(formatCompactTaskList(tasks, TZ).text).toMatch(/"Gloves" deck:/)
  })
})
