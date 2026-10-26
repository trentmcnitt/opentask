/**
 * AI enrichment — RELATIVE TARGETS (2026-10-24, PR C; plan §5, rulings 9 and
 * 10, decision 12). No model runs: these pin what the code does with an
 * answer that counts a target back from the deadline —
 * - `RELATIVE_CUE`, the wording floor (ruling 9);
 * - `relativeTargetTime`, the time table: a clock time said, "morning" / no
 *   part of the day → the Default task time copied (linked or custom), a
 *   period's exact name → linked, any other part of the day → a custom time;
 * - `sanitizeTaskModelFields` / `resolveEnrichmentRelative`: dropped with no
 *   cue, no deadline, a rule, or a time on the deadline day after the deadline; when
 *   kept, due_at and the deck day go;
 * - the write: the three columns and the derived target, linked at write time.
 */

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
import { createTask, getTaskById } from '@/core/tasks'
import { listTimeSlots } from '@/core/time-slots'
import {
  enrichSingleTask,
  postProcessTaskEnrichment,
  resolveEnrichmentRelative,
  sanitizeReminderEnrichment,
  sanitizeTaskModelFields,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import {
  PART_OF_DAY_TIMES,
  RELATIVE_CUE,
  relativeTargetTime,
  type RelativeTimeContext,
} from '@/core/ai/relative-wording'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import {
  offEnrichmentCompleteEvent,
  onEnrichmentCompleteEvent,
  type EnrichmentCompletePayload,
} from '@/lib/sync-events'
import type { EnrichmentResult } from '@/core/ai/types'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

function slots(list: Array<[string, string]>): TimeSlot[] {
  return list.map(([label, start_time], i) => ({
    id: i + 1,
    user_id: 1,
    label,
    start_time,
    sort_order: i,
    created_at: '2026-01-01T00:00:00Z',
  }))
}

const MORNING_EVENING = slots([
  ['Morning', '06:30'],
  ['Afternoon', '13:00'],
  ['Evening', '20:30'],
])
const AM_PM_NIGHT = slots([
  ['AM', '07:00'],
  ['PM', '13:00'],
  ['Night', '21:00'],
])

const custom = (s: TimeSlot[], time = '09:00'): RelativeTimeContext => ({
  slots: s,
  defaultTime: { time, slot_id: null },
})

function answer(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    reasoning: 'test',
    title: 'Clean title',
    due_at: null,
    deadline_at: null,
    target_days_before: null,
    target_time: null,
    target_period: null,
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

describe('RELATIVE_CUE: only wording counted back from a deadline', () => {
  test.each([
    'by Tue 8:30am, remind me the evening before',
    'remind me the night before',
    'due Friday, target the morning of',
    'rent due the 1st, nag me 2 days before',
    'remind me two days before',
    'a week before',
    'the day prior',
    'remind me the day of',
    'remind me at 6pm the day before',
  ])('cue: %s', (text) => expect(RELATIVE_CUE.test(text)).toBe(true))

  test.each([
    'by Monday, do it Sunday morning',
    'cancel it by the 17th, do it Wednesday',
    'drop it off before work',
    'call mom tomorrow morning before work',
    'do it the morning of the 12th',
    'the evening of Friday',
    'before the trip',
  ])('no cue: %s', (text) => expect(RELATIVE_CUE.test(text)).toBe(false))
})

describe('relativeTargetTime: the time table (decision 12, ruling 10)', () => {
  const text = 'by Tue 8:30am, remind me the evening before'

  test('a period whose name is the user’s word → linked to it, at its start', () => {
    expect(
      relativeTargetTime(
        { target_period: 'Evening', target_time: null },
        text,
        custom(MORNING_EVENING),
      ),
    ).toEqual({ time: '20:30', slot_id: 3, source: 'period' })
    // Case-insensitive, both ways.
    expect(
      relativeTargetTime(
        { target_period: 'evening', target_time: null },
        text,
        custom(MORNING_EVENING),
      ),
    ).toMatchObject({ slot_id: 3 })
  })

  test('no period of that name → a custom time from the part of day', () => {
    expect(
      relativeTargetTime(
        { target_period: 'evening', target_time: null },
        text,
        custom(AM_PM_NIGHT),
      ),
    ).toEqual({ time: PART_OF_DAY_TIMES.evening, slot_id: null, source: 'part_of_day' })
    expect(PART_OF_DAY_TIMES).toEqual({
      midday: '12:00',
      afternoon: '13:00',
      evening: '18:00',
      night: '20:00',
    })
  })

  test('a period the time falls in but the user did not name is never linked', () => {
    // The model said "Night" for "the evening before": the word in the input
    // is "evening", so evening's custom time.
    expect(
      relativeTargetTime({ target_period: 'Night', target_time: null }, text, custom(AM_PM_NIGHT)),
    ).toEqual({ time: '18:00', slot_id: null, source: 'part_of_day' })
  })

  test('"the night before" with a Night period → linked; without → 20:00', () => {
    const night = 'remind me the night before'
    expect(
      relativeTargetTime({ target_period: 'Night', target_time: null }, night, custom(AM_PM_NIGHT)),
    ).toEqual({ time: '21:00', slot_id: 3, source: 'period' })
    expect(
      relativeTargetTime(
        { target_period: 'night', target_time: null },
        night,
        custom(MORNING_EVENING),
      ),
    ).toEqual({ time: '20:00', slot_id: null, source: 'part_of_day' })
  })

  test('"morning" → the Default task time, even with a period named Morning', () => {
    expect(
      relativeTargetTime(
        { target_period: 'Morning', target_time: null },
        'due Friday, target the morning of',
        custom(MORNING_EVENING),
      ),
    ).toEqual({ time: '09:00', slot_id: null, source: 'default' })
  })

  test('no part of the day → the Default task time', () => {
    expect(
      relativeTargetTime(
        { target_period: null, target_time: null },
        'rent due the 1st, nag me 2 days before',
        custom(MORNING_EVENING, '08:15'),
      ),
    ).toEqual({ time: '08:15', slot_id: null, source: 'default' })
  })

  test('the Default task time is copied as it is: linked when linked (ruling 10)', () => {
    const linked = { slots: MORNING_EVENING, defaultTime: { time: '06:30', slot_id: 1 } }
    expect(
      relativeTargetTime({ target_period: null, target_time: null }, 'the day before', linked),
    ).toEqual({ time: '06:30', slot_id: 1, source: 'default' })
    // A link to a period that is gone reads its snapshot, custom.
    const gone = { slots: MORNING_EVENING, defaultTime: { time: '07:45', slot_id: 99 } }
    expect(
      relativeTargetTime({ target_period: null, target_time: null }, 'the day before', gone),
    ).toEqual({ time: '07:45', slot_id: null, source: 'default' })
  })

  test('a clock time said for it → custom, even over a period', () => {
    expect(
      relativeTargetTime(
        { target_period: null, target_time: '18:00' },
        'by Thursday, remind me at 6pm the day before',
        custom(MORNING_EVENING),
      ),
    ).toEqual({ time: '18:00', slot_id: null, source: 'clock' })
    expect(
      relativeTargetTime(
        { target_period: 'Evening', target_time: '19:00' },
        'by Thursday, remind me the evening before at 7pm',
        custom(MORNING_EVENING),
      ),
    ).toEqual({ time: '19:00', slot_id: null, source: 'clock' })
  })

  test('a clock time outside the part of day said, or none in the words, is not taken', () => {
    // The deadline's 8:30am is not the evening before's time.
    expect(
      relativeTargetTime(
        { target_period: 'Evening', target_time: '08:30' },
        text,
        custom(MORNING_EVENING),
      ),
    ).toMatchObject({ time: '20:30', source: 'period' })
    // No clock time in the words at all: an invented one is ignored.
    expect(
      relativeTargetTime(
        { target_period: null, target_time: '17:00' },
        'rent due the 1st, nag me 2 days before',
        custom(MORNING_EVENING),
      ),
    ).toMatchObject({ time: '09:00', source: 'default' })
  })
})

describe('sanitizeTaskModelFields: the relative floor (ruling 9)', () => {
  const offsets = { target_days_before: 1, target_time: null, target_period: 'Evening' }

  test('kept with a cue and a deadline: due_at and the deck day go', () => {
    const out = sanitizeTaskModelFields(
      answer({
        ...offsets,
        deadline_at: '2026-10-13T08:30:00',
        due_at: '2026-10-12T20:30:00',
        on_deck_day: '2026-10-12',
      }),
      'by Tue 8:30am, remind me the evening before',
    )
    expect(out).toMatchObject({ ...offsets, due_at: null, on_deck_day: null })
  })

  test.each([
    ['no cue', 'by Monday, do it Sunday morning', '2026-10-12T23:59:00', null],
    ['no deadline', 'order flowers the day before her birthday on the 12th', null, null],
    ['a rule', 'every Friday by 5pm, remind me the day before', null, 'FREQ=WEEKLY;BYDAY=FR'],
    ['no deadline (no date)', 'pack the chargers, remind me the night before the trip', null, null],
  ])('dropped: %s', (_why, text, deadline, rrule) => {
    const out = sanitizeTaskModelFields(
      answer({ ...offsets, deadline_at: deadline, rrule, due_at: '2026-10-11T09:00:00' }),
      text,
    )
    expect(out).toMatchObject({
      target_days_before: null,
      target_time: null,
      target_period: null,
      target_slot_id: null,
      due_at: '2026-10-11T09:00:00',
    })
  })

  test('a deadline the cue guard drops takes the offsets with it', () => {
    // "the morning of" with no cutoff word ("before" is one): the deadline goes, so do they.
    const out = sanitizeTaskModelFields(
      answer({ ...offsets, deadline_at: '2026-10-13T23:59:00' }),
      'water the plants the morning of',
    )
    expect(out.deadline_at).toBeNull()
    expect(out.target_days_before).toBeNull()
  })

  test('a reminder never keeps them', () => {
    const out = sanitizeReminderEnrichment(
      answer({ ...offsets, target_time: '20:30', rrule: 'FREQ=DAILY' }),
      MORNING_EVENING,
      'Morning',
    )
    expect(out).toMatchObject({ target_days_before: null, target_time: null, target_period: null })
  })
})

describe('resolveEnrichmentRelative: the mapped result', () => {
  test('maps the time and the link', () => {
    const out = resolveEnrichmentRelative(
      answer({
        deadline_at: '2026-10-13T08:30:00',
        target_days_before: 1,
        target_period: 'Evening',
      }),
      'by Tue 8:30am, remind me the evening before',
      custom(MORNING_EVENING),
    )
    expect(out).toMatchObject({ target_days_before: 1, target_time: '20:30', target_slot_id: 3 })
  })

  test('a time on the deadline day after the deadline is dropped (never a failure)', () => {
    const out = resolveEnrichmentRelative(
      answer({
        deadline_at: '2026-10-13T08:30:00',
        target_days_before: 0,
        target_period: 'Evening',
      }),
      'by Tue 8:30am, remind me the evening of',
      custom(MORNING_EVENING),
    )
    expect(out).toMatchObject({ target_days_before: null, target_time: null, target_slot_id: null })
    expect(out.deadline_at).toBe('2026-10-13T08:30:00')
  })

  test('the whole post-process: a deck day the model wrote is not kept beside them', () => {
    vi.setSystemTime(new Date('2026-10-11T01:00:00Z'))
    try {
      const out = postProcessTaskEnrichment(
        answer({
          deadline_at: '2026-10-13T08:30:00',
          due_at: '2026-10-12',
          target_days_before: 1,
          target_period: 'evening',
        }),
        'submit it by Tuesday 8:30am, remind me the evening before',
        TEST_TIMEZONE,
        {
          morningTime: '09:00',
          todayTarget: '2026-10-11T14:00:00.000Z',
          dayStart: CALENDAR_DAY_START,
          relative: custom(AM_PM_NIGHT),
        },
      )
      expect(out).toMatchObject({
        due_at: null,
        on_deck_day: null,
        target_days_before: 1,
        target_time: '18:00',
        target_slot_id: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the write (enrichSingleTask)', () => {
  function modelAnswer(overrides: Partial<EnrichmentResult>) {
    return { structuredOutput: { ...answer(overrides) }, text: null, durationMs: 50 }
  }
  const titleOnly = (title: string) =>
    createTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, input: { title } })

  beforeAll(() => {
    setupTestDb()
    getDb().prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
  })
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    // Sat Oct 10 2026, 8 PM Chicago (CDT, UTC-5)
    vi.setSystemTime(new Date('2026-10-11T01:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    mockEnrichmentQuery.mockReset()
    _resetCircuitBreaker()
    _resetProcessingState()
  })

  test('"the evening before" → the three columns, the derived target, linked to Evening', async () => {
    const evening = listTimeSlots(TEST_USER_ID).find((s) => s.label === 'Evening')!
    const task = titleOnly('submit the permit renewal by Tue 8:30am, remind me the evening before')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Submit the permit renewal',
        deadline_at: '2026-10-13T08:30:00',
        target_days_before: 1,
        target_period: evening.label,
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.deadline_at).toBe('2026-10-13T13:30:00.000Z')
    expect(after.target_days_before).toBe(1)
    expect(after.target_time).toBe(evening.start_time)
    expect(after.target_slot_id).toBe(evening.id)
    // Mon Oct 12 at the Evening period's start, CDT.
    const [h, m] = evening.start_time.split(':').map(Number)
    expect(after.due_at).toBe(new Date(Date.UTC(2026, 9, 12, h + 5, m)).toISOString())
    expect(after.target_auto).toBe(false)
    expect(after.on_deck_day).toBeNull()
  })

  test('"nag me 2 days before" → the Default task time, custom', async () => {
    const task = titleOnly('rent due the 1st, nag me 2 days before')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Pay rent',
        deadline_at: '2026-11-01T23:59:00',
        target_days_before: 2,
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    const morning = getDb()
      .prepare('SELECT morning_time FROM users WHERE id = ?')
      .get(TEST_USER_ID) as { morning_time: string }
    expect(after.target_days_before).toBe(2)
    expect(after.target_time).toBe(morning.morning_time)
    expect(after.target_slot_id).toBeNull()
    expect(after.due_at).not.toBeNull()
    expect(after.rrule).toBeNull()
  })

  test('no cue in the words: the offsets are never written', async () => {
    const task = titleOnly('book the movers by Tuesday, do it Monday morning')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Book the movers',
        deadline_at: '2026-10-13T23:59:00',
        due_at: '2026-10-12T09:00:00',
        target_days_before: 1,
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.target_days_before).toBeNull()
    expect(after.target_time).toBeNull()
    expect(after.due_at).toBe('2026-10-12T14:00:00.000Z')
  })

  test('the toast for a 0-day offset reads "the deadline day" (the shared words, PR B)', async () => {
    const descriptions: string[] = []
    const listener = (_userId: number, payload: EnrichmentCompletePayload) => {
      if (payload.description) descriptions.push(payload.description)
    }
    onEnrichmentCompleteEvent(listener)
    try {
      const task = titleOnly('pay the registration fee, due Tuesday, target the morning of')
      mockEnrichmentQuery.mockResolvedValueOnce(
        modelAnswer({
          title: 'Pay the registration fee',
          deadline_at: '2026-10-13T23:59:00',
          target_days_before: 0,
          target_period: 'morning',
        }),
      )

      await enrichSingleTask(task.id, TEST_USER_ID)

      expect(getTaskById(task.id)!.target_days_before).toBe(0)
      expect(descriptions.join(' | ')).toMatch(/the deadline day at \d{1,2}:\d{2} [AP]M/)
      expect(descriptions.join(' | ')).not.toMatch(/same day/)
    } finally {
      offEnrichmentCompleteEvent(listener)
    }
  })

  test('a relative target the AI sets takes a deck off (a pick, plan §3)', async () => {
    const task = titleOnly('return the drill by Tuesday, remind me the day before')
    getDb().prepare('UPDATE tasks SET on_deck_day = ? WHERE id = ?').run('2026-10-11', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Return the drill',
        deadline_at: '2026-10-13T23:59:00',
        target_days_before: 1,
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.target_days_before).toBe(1)
    expect(after.due_at).not.toBeNull()
    expect(after.on_deck_day).toBeNull()
  })
})
