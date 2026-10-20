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
import {
  enrichSingleTask,
  postProcessTaskDates,
  deckDayAsTarget,
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
      { morningTime: '09:00', todayTarget: TODAY_TARGET, now: TUE_2PM, newTask: true },
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
      { morningTime: '09:00', todayTarget: TODAY_TARGET, now: TUE_2PM, newTask: true },
    )
    expect(out.on_deck_day ?? null).toBeNull()
    expect(out.due_at).toBeNull()
    expect(out.horizon).toBe('days')
  })
})

describe('deckDayAsTarget (the fallback when the deck cannot be written)', () => {
  test('today → the "Target today" time; another day → the default task time', () => {
    expect(deckDayAsTarget('2026-10-20', TZ, '09:00', TODAY_TARGET, TUE_2PM)).toBe(TODAY_TARGET)
    expect(deckDayAsTarget('2026-10-24', TZ, '09:00', TODAY_TARGET, TUE_2PM)).toBe(
      '2026-10-24T14:00:00.000Z',
    )
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
