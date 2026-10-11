/**
 * AI enrichment — the 2026-10-10 task model fields (deadline_at, horizon)
 *
 * The model is mocked; these tests pin what the pipeline does with its answer:
 * - a deadline converts from local time to UTC (a date-only one arrives as
 *   23:59 local), separately from the target in due_at
 * - the code guard drops a deadline with no cutoff word and a horizon with no
 *   pace word (no inference from topic), and both on a recurring result
 * - a horizon starts its clock (horizon_set_at)
 * - reminders and quotas never get either field
 * - re-enrichment logs them for undo
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
  sanitizeTaskModelFields,
  sanitizeReminderEnrichment,
  alignTaskModelDates,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import type { EnrichmentResult } from '@/core/ai/types'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

function modelAnswer(overrides: Partial<EnrichmentResult>) {
  return {
    structuredOutput: {
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
    },
    text: null,
    durationMs: 50,
  }
}

function result(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return modelAnswer(overrides).structuredOutput as EnrichmentResult
}

function titleOnly(title: string) {
  return createTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, input: { title } })
}

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

describe('deadline and target', () => {
  test('quick capture: "Cancel M365 by Oct 17, do it Wednesday" stores both, in UTC', async () => {
    const task = titleOnly('Cancel M365 by Oct 17, do it Wednesday')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Cancel M365',
        due_at: '2026-10-14T09:00:00',
        deadline_at: '2026-10-17T23:59:00',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    // 9 AM CDT = 14:00 UTC; 23:59 CDT on the 17th = 04:59 UTC on the 18th
    expect(after.due_at).toBe('2026-10-14T14:00:00.000Z')
    expect(after.deadline_at).toBe('2026-10-18T04:59:00.000Z')
    expect(after.horizon).toBeNull()
  })

  test('a deadline with no target leaves due_at empty', async () => {
    const task = titleOnly('use the voucher before it expires on the 13th')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Use the voucher', deadline_at: '2026-10-13T23:59:00' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.due_at).toBeNull()
    expect(after.deadline_at).toBe('2026-10-14T04:59:00.000Z')
  })

  test('a deadline the wording never stated is dropped', async () => {
    const task = titleOnly('call mom friday')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Call mom',
        due_at: '2026-10-16T09:00:00',
        deadline_at: '2026-10-16T23:59:00',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.due_at).toBe('2026-10-16T14:00:00.000Z')
    expect(after.deadline_at).toBeNull()
  })

  test('an unparseable deadline is dropped, the rest still applies', async () => {
    const task = titleOnly('renew it by friday')
    // Date.parse accepts it (so the schema does), Luxon's ISO parser does not.
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Renew it', deadline_at: '2026/10/16 23:59' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Renew it')
    expect(after.deadline_at).toBeNull()
  })
})

describe('horizon', () => {
  test('pace wording sets the horizon and starts its clock', async () => {
    const task = titleOnly('sometime this month reorganize the pantry')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Reorganize the pantry', horizon: 'months' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.horizon).toBe('months')
    expect(after.horizon_set_at).not.toBeNull()
    expect(after.due_at).toBeNull()
  })

  test('a horizon inferred from the topic is dropped', async () => {
    const task = titleOnly('fix the squeaky door')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Fix the squeaky door', horizon: 'eventually' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.horizon).toBeNull()
    expect(after.horizon_set_at).toBeNull()
  })
})

describe('the guard (sanitizeTaskModelFields)', () => {
  test('keeps cutoff and pace wording, drops both on a recurring result', () => {
    expect(
      sanitizeTaskModelFields(
        result({ deadline_at: '2026-10-17T23:59:00', horizon: 'weeks' }),
        'pay it by the 17th, sometime this week',
      ),
    ).toMatchObject({ deadline_at: '2026-10-17T23:59:00', horizon: 'weeks' })

    expect(
      sanitizeTaskModelFields(
        result({
          rrule: 'FREQ=WEEKLY;BYDAY=FR',
          deadline_at: '2026-10-16T17:00:00',
          horizon: 'weeks',
        }),
        'submit timesheet every Friday by 5pm this week',
      ),
    ).toMatchObject({ deadline_at: null, horizon: null })
  })

  test('"latest" and "good through" are cutoff wording; bare "through" is not', () => {
    const deadline = (text: string) =>
      sanitizeTaskModelFields(result({ deadline_at: '2026-10-12T10:00:00' }), text).deadline_at
    expect(deadline('text Matthew today, latest tomorrow 10 AM')).toBe('2026-10-12T10:00:00')
    expect(deadline('return the library books Friday at the latest')).toBe('2026-10-12T10:00:00')
    expect(deadline('use the coupon, it is good through the 20th')).toBe('2026-10-12T10:00:00')
    expect(deadline('the sale runs through Sunday, buy the rug')).toBe('2026-10-12T10:00:00')
    expect(deadline('go through the mail Monday')).toBeNull()
  })

  test('bare "today" / "tomorrow" are a day, not a pace', () => {
    expect(
      sanitizeTaskModelFields(result({ horizon: 'days' }), 'call mom tomorrow').horizon,
    ).toBeNull()
    expect(
      sanitizeTaskModelFields(result({ horizon: 'days' }), 'today or tomorrow, call mom').horizon,
    ).toBe('days')
  })

  test('a reminder result carries neither field', () => {
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=DAILY', deadline_at: '2026-10-17T23:59:00', horizon: 'days' }),
      [],
      null,
    )
    expect(out.deadline_at).toBeNull()
    expect(out.horizon).toBeNull()
  })
})

describe('date sanity (alignTaskModelDates)', () => {
  const now = new Date('2026-10-11T01:00:00Z') // Sat Oct 10, 8 PM Chicago

  test('a month/day long past is next year', () => {
    expect(
      alignTaskModelDates(result({ deadline_at: '2026-02-28T23:59:00' }), TEST_TIMEZONE, now)
        .deadline_at,
    ).toBe('2027-02-28T23:59:00')
  })

  test('a recurring first date given this year by mistake is next year', () => {
    expect(
      alignTaskModelDates(
        result({ due_at: '2026-03-01T09:00:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1' }),
        TEST_TIMEZONE,
        now,
      ).due_at,
    ).toBe('2027-03-01T09:00:00')
  })

  test('a deadline that passed days ago stays as said', () => {
    expect(
      alignTaskModelDates(result({ deadline_at: '2026-10-07T23:59:00' }), TEST_TIMEZONE, now)
        .deadline_at,
    ).toBe('2026-10-07T23:59:00')
  })

  test('a target after the deadline is dropped; one before it is kept', () => {
    const late = alignTaskModelDates(
      result({ due_at: '2026-10-10T22:00:00', deadline_at: '2026-10-10T21:00:00' }),
      TEST_TIMEZONE,
      now,
    )
    expect(late).toMatchObject({ due_at: null, deadline_at: '2026-10-10T21:00:00' })

    const early = alignTaskModelDates(
      result({ due_at: '2026-10-14T09:00:00', deadline_at: '2026-10-17T23:59:00' }),
      TEST_TIMEZONE,
      now,
    )
    expect(early.due_at).toBe('2026-10-14T09:00:00')
  })
})

describe('kinds that never get the fields', () => {
  test('a quota keeps no deadline or horizon on re-enrichment', async () => {
    const quota = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Lift weights', rrule: 'FREQ=WEEKLY', is_tracked: true, progress_target: 3 },
    })
    getDb()
      .prepare(
        "UPDATE tasks SET labels = json_insert(labels, '$[#]', 'ai-to-process') WHERE id = ?",
      )
      .run(quota.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Lift weights',
        deadline_at: '2026-10-17T23:59:00',
        horizon: 'weeks',
      }),
    )

    await enrichSingleTask(quota.id, TEST_USER_ID)

    const after = getTaskById(quota.id)!
    expect(after.deadline_at).toBeNull()
    expect(after.horizon).toBeNull()
  })
})

describe('undo', () => {
  test('re-enrichment that sets a deadline and horizon is undone in one step', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'renew the passport by the 30th, sometime this week', priority: 2 },
    })
    // A user edit first, so this is a RE-enrichment — the initial one rides on
    // the create entry and logs nothing of its own.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { notes: 'old one expires in December' },
    })
    getDb()
      .prepare(
        "UPDATE tasks SET labels = json_insert(labels, '$[#]', 'ai-to-process') WHERE id = ?",
      )
      .run(task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Renew the passport',
        priority: 2,
        deadline_at: '2026-10-30T23:59:00',
        horizon: 'weeks',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.deadline_at).toBe('2026-10-31T04:59:00.000Z')

    executeUndo(TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.deadline_at).toBeNull()
    expect(after.horizon).toBeNull()
    expect(after.horizon_set_at).toBeNull()
    expect(after.title).toBe('renew the passport by the 30th, sometime this week')
  })
})
