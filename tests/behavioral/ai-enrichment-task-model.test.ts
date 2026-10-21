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
  resolveDateOnlyTarget,
  resolveBareTime,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import type { EnrichmentResult } from '@/core/ai/types'
import { targetTodayTime } from '@/core/tasks/task-segments'

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
  test('a rule is never written onto a task with a deadline (until PR 5, 2026-10-21)', async () => {
    const task = titleOnly('pay the invoice every friday')
    getDb()
      .prepare('UPDATE tasks SET deadline_at = ? WHERE id = ?')
      .run('2026-10-16T22:00:00.000Z', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Pay the invoice', rrule: 'FREQ=WEEKLY;BYDAY=FR' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Pay the invoice')
    expect(after.rrule).toBeNull()
    expect(after.deadline_at).toBe('2026-10-16T22:00:00.000Z')
  })

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

  test('a deadline with no target gets the automatic target (§8.1)', async () => {
    const task = titleOnly('use the voucher before it expires on the 13th')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Use the voucher', deadline_at: '2026-10-13T23:59:00' }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    // Clock: Sat Oct 10, 20:00 Chicago. Deadline Tue Oct 13 → a 3-day wait
    // → the day before, Mon Oct 12 at 9:00 AM (2026-10-21's one lead table).
    expect(after.due_at).toBe('2026-10-12T14:00:00.000Z')
    expect(after.target_auto).toBe(true)
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

describe('a repeat whose first date today has passed (rollPassedRepeatStart, 2026-10-16)', () => {
  // Enrichment writes the rule and date onto an existing task (an update, not
  // createTask), so it applies the create path's rule itself. Clock: Sat Oct
  // 10, 8 PM Chicago.
  test('weekly Saturday 5 PM, given today 5 PM → next Saturday', async () => {
    const task = titleOnly('water the plants every Saturday at 5pm')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Water the plants',
        due_at: '2026-10-10T17:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=17;BYMINUTE=0',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    // Sat Oct 17, 5 PM CDT = 22:00 UTC; the occurrence starts there too.
    expect(after.due_at).toBe('2026-10-17T22:00:00.000Z')
    expect(after.occurrence_at).toBe('2026-10-17T22:00:00.000Z')
  })

  test('a new task given an earlier day: "15th of every month" given Oct 9 → Oct 15', async () => {
    // Clock: Sat Oct 10, 8 PM. The model dated the first occurrence Oct 9.
    const task = titleOnly('pay the mortgage on the 9th of every month')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Pay the mortgage',
        due_at: '2026-10-09T09:00:00',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    // Nov 9, 9 AM CST = 15:00 UTC.
    expect(getTaskById(task.id)!.due_at).toBe('2026-11-09T15:00:00.000Z')
  })

  test('re-enriching an EXISTING repeating task never rolls its date', async () => {
    // A repeating task the user already has (a rule and a date), re-enriched
    // by adding ai-to-process: an edit, not a new task.
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'water the plants every Saturday at 5pm',
        due_at: '2026-10-17T22:00:00.000Z',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=17;BYMINUTE=0',
      },
    })
    getDb()
      .prepare('UPDATE tasks SET labels = ? WHERE id = ?')
      .run(JSON.stringify(['ai-to-process']), task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Water the plants',
        due_at: '2026-10-10T17:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=17;BYMINUTE=0',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    // The model's date today 5 PM (passed) is applied as given, not rolled.
    expect(getTaskById(task.id)!.due_at).toBe('2026-10-10T22:00:00.000Z')
  })

  test('a first date today still ahead stays today', async () => {
    const task = titleOnly('take out the trash every Saturday at 9pm')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Take out the trash',
        due_at: '2026-10-10T21:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=21;BYMINUTE=0',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    expect(getTaskById(task.id)!.due_at).toBe('2026-10-11T02:00:00.000Z')
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

describe('a target with a day but no time (resolveDateOnlyTarget)', () => {
  // Frozen at Sat Oct 10 2026, 8 PM Chicago (beforeEach above).
  test('"today" with no time lands where Target today would put it, never now', async () => {
    const task = titleOnly('text Matthew today, latest tomorrow 10 AM')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({
        title: 'Text Matthew',
        due_at: '2026-10-10',
        deadline_at: '2026-10-11T10:00:00',
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    const expected = targetTodayTime(TEST_USER_ID, TEST_TIMEZONE)
    expect(Date.parse(after.due_at!)).toBe(Date.parse(expected))
    expect(Date.parse(after.due_at!)).toBeGreaterThan(Date.now())
    expect(after.deadline_at).toBe('2026-10-11T15:00:00.000Z')
  })

  test('a stated time today is kept; another bare day gets the default task time', () => {
    const today = '2026-10-11T02:00:00.000Z' // what targetTodayTime would return
    expect(
      resolveDateOnlyTarget(
        result({ due_at: '2026-10-10T21:30:00' }),
        'water the tomatoes today at 9:30pm',
        'America/Chicago',
        '09:00',
        today,
      ).due_at,
    ).toBe('2026-10-10T21:30:00')
    expect(
      resolveDateOnlyTarget(
        result({ due_at: '2026-10-10' }),
        'call the pharmacy today',
        'America/Chicago',
        '09:00',
        today,
      ).due_at,
    ).toBe('2026-10-10T21:00:00')
    // No "today" in the words: the model invented the day, so there is no target.
    expect(
      resolveDateOnlyTarget(
        result({ due_at: '2026-10-10' }),
        'check the mail',
        'America/Chicago',
        '09:00',
        today,
      ).due_at,
    ).toBeNull()
    expect(
      resolveDateOnlyTarget(
        result({ due_at: '2026-10-13' }),
        'renew it Tuesday',
        'America/Chicago',
        '08:30',
        today,
      ).due_at,
    ).toBe('2026-10-13T08:30:00')
  })
})

describe('a time with no day (resolveBareTime)', () => {
  // Pure: each call passes its own `now`. Wed Oct 14 2026, Chicago (UTC-5).
  const at = (local: string) => new Date(`${local}-05:00`)
  const bare = (due_at: string | null, text: string, now: string, rrule: string | null = null) =>
    resolveBareTime(result({ due_at, rrule }), text, 'America/Chicago', at(now)).due_at

  test('a time still ahead today stays today; one already passed moves to tomorrow', () => {
    expect(bare('2026-10-14T08:30:00', 'Add Matthew time 8:30am', '2026-10-14T05:37:00')).toBe(
      '2026-10-14T08:30:00',
    )
    expect(bare('2026-10-14T08:30:00', 'Add Matthew time 8:30am', '2026-10-14T10:00:00')).toBe(
      '2026-10-15T08:30:00',
    )
    // A target further ahead than tomorrow is never pulled earlier; a day the
    // regex can't read ("tommorow") is still a day.
    expect(bare('2026-10-16T19:00:00', 'call mom 7pm', '2026-10-14T15:00:00')).toBe(
      '2026-10-16T19:00:00',
    )
    expect(
      bare('2026-10-15T15:00:00', 'dentist appointment tommorow at 3pm', '2026-10-14T10:00:00'),
    ).toBe('2026-10-15T15:00:00')
    // Exactly now is not ahead.
    expect(bare('2026-10-14T19:00:00', 'call mom 7pm', '2026-10-14T19:00:00')).toBe(
      '2026-10-15T19:00:00',
    )
  })

  test('the hour and minute stay the model\'s; no-colon and "at" times count', () => {
    expect(bare('2026-10-13T08:30:00', 'Review the slides 830am', '2026-10-14T07:00:00')).toBe(
      '2026-10-14T08:30:00',
    )
    expect(bare('2026-10-13T15:00:00', 'Call the bank at 3', '2026-10-14T16:00:00')).toBe(
      '2026-10-15T15:00:00',
    )
  })

  // Prod, 2026-10-20: "at noon" said at 10:58 came back tomorrow noon while the
  // model's own reasoning said today. Tomorrow is pulled back to today only
  // when nothing in the words could be a day the regex can't read.
  test('tomorrow at a time still ahead today is pulled back to today', () => {
    const text = 'Order replacement books at noon urgent priority'
    expect(bare('2026-10-15T12:00:00', text, '2026-10-14T10:58:00')).toBe('2026-10-14T12:00:00')
    expect(bare('2026-10-15T12:00:00', text, '2026-10-14T12:30:00')).toBe('2026-10-15T12:00:00')
    expect(bare('2026-10-15T19:00:00', 'call mom 7pm', '2026-10-14T15:00:00')).toBe(
      '2026-10-14T19:00:00',
    )
    // "at midnight" at 10 PM: tomorrow 00:00 is the next midnight.
    expect(bare('2026-10-15T00:00:00', 'lock up at midnight', '2026-10-14T22:00:00')).toBe(
      '2026-10-15T00:00:00',
    )
  })

  test("a word that could be a misspelled day keeps the model's tomorrow", () => {
    // Wed Oct 14 at 10:58; tomorrow is Thursday Oct 15.
    const keep = (text: string, due = '2026-10-15T12:00:00') =>
      expect(bare(due, text, '2026-10-14T10:58:00')).toBe(due)
    keep('Order replacement books tommorow at noon')
    keep('Order replacement books tmorow at noon')
    keep('Order replacement books 2moro at noon')
    keep('Order replacement books tmr at noon')
    keep('call the dentist thrusday at noon')
    keep('call the dentist tusday at 3pm', '2026-10-15T15:00:00')
    keep('call the dentist wensday at 3pm', '2026-10-15T15:00:00')
    keep('call the dentist thurday at noon')
    keep('call the dentist thirsday at noon')
    keep('pay rent ocotber 15 at noon')
    keep('pay rent on the 15 at noon')
    keep('Halloween party at 7pm', '2026-10-15T19:00:00')
    keep('call grandma for her birthday at noon')
  })

  test('words that name a day, a null target, a repeat, or no clock time are left alone', () => {
    expect(
      bare('2026-10-14T21:00:00', 'at 9 tonight take out the trash', '2026-10-14T22:00:00'),
    ).toBe('2026-10-14T21:00:00')
    expect(
      bare('2026-10-16T15:00:00', 'call the plumber Friday at 3pm', '2026-10-14T10:00:00'),
    ).toBe('2026-10-16T15:00:00')
    expect(bare('2026-10-14T08:30:00', 'standup tomorrow 830am', '2026-10-14T10:00:00')).toBe(
      '2026-10-14T08:30:00',
    )
    expect(bare(null, 'Add Matthew time 8:30am', '2026-10-14T10:00:00')).toBeNull()
    expect(
      bare('2026-10-14T07:00:00', 'take meds 7am every day', '2026-10-14T10:00:00', 'FREQ=DAILY'),
    ).toBe('2026-10-14T07:00:00')
    expect(bare('2026-10-14T09:00:00', 'check the mail', '2026-10-14T10:00:00')).toBe(
      '2026-10-14T09:00:00',
    )
  })
})
