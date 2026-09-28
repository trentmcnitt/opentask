/**
 * The default reminder slot (Trent, 2026-09-28)
 *
 * "Adding a reminder should be just like adding a task. It should go to
 * enrichment, which then decides what slot to put it in." A reminder created
 * with nothing saying when — an Apple Shortcut POSTing `{title, is_reminder}`,
 * the Reminders quick add — lands at once in the user's DEFAULT reminder slot
 * (`users.quota_prompt_slot_id`, resolved like quota prompts: the stored slot,
 * else the first period), daily at its start, and is still enriched. The AI,
 * finding no time cue, keeps it in the default slot; if AI is off or the
 * enrichment fails, it simply stays there.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

const ai = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => ai.enabled,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: vi.fn(),
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(() => ({
    state: 'available',
    model: 'haiku',
    totalRequests: 0,
    totalRecycles: 0,
    activatedAt: null,
    lastRequestAt: null,
  })),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import {
  enrichSingleTask,
  sanitizeReminderEnrichment,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import {
  defaultReminderRule,
  defaultReminderSlot,
  listTimeSlots,
  seedDefaultTimeSlots,
} from '@/core/time-slots'
import type { EnrichmentResult } from '@/core/ai/types'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

function setDefault(id: number | null): void {
  getDb().prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(id, TEST_USER_ID)
}

function titleOnlyReminder(title = 'notice what I am grateful for') {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, is_reminder: true },
  })
}

function aiResult(overrides: Partial<EnrichmentResult> = {}) {
  return {
    structuredOutput: {
      title: 'Notice what I am grateful for',
      due_at: null,
      priority: 0,
      labels: [],
      project_name: null,
      rrule: 'FREQ=DAILY;BYHOUR=16;BYMINUTE=0',
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      reasoning: 'test',
      ...overrides,
    },
    text: null,
    durationMs: 10,
  }
}

beforeAll(() => {
  setupTestDb()
  getDb().prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  ai.enabled = true
  setDefault(null)
})

afterEach(() => {
  _resetCircuitBreaker()
  _resetProcessingState()
  mockEnrichmentQuery.mockReset()
})

describe('defaultReminderSlot', () => {
  test('unset → the first period of the day (the quota-prompt fallback)', () => {
    expect(defaultReminderSlot(TEST_USER_ID)?.label).toBe('Early morning')
    expect(defaultReminderRule(TEST_USER_ID)).toBe('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
  })

  test('set → that slot, daily at its start', () => {
    setDefault(slotId('Evening'))
    expect(defaultReminderSlot(TEST_USER_ID)?.label).toBe('Evening')
    expect(defaultReminderRule(TEST_USER_ID)).toBe('FREQ=DAILY;BYHOUR=20;BYMINUTE=30')
  })

  test('a stale id (slot gone) falls back to the first period', () => {
    setDefault(999999)
    expect(defaultReminderSlot(TEST_USER_ID)?.label).toBe('Early morning')
  })
})

describe('creating a reminder with no schedule', () => {
  test('title only → the default slot at once, AND still queued for enrichment', () => {
    setDefault(slotId('Afternoon'))
    const task = titleOnlyReminder()
    const row = getTaskById(task.id)!
    expect(row.is_reminder).toBe(true)
    expect(row.rrule).toBe('FREQ=DAILY;BYHOUR=16;BYMINUTE=0')
    expect(row.anchor_time).toBe('16:00')
    expect(row.due_at).not.toBeNull()
    expect(row.labels).toContain('ai-to-process')
  })

  test('AI off → still in the default slot, no enrichment label', () => {
    ai.enabled = false
    setDefault(slotId('Midday'))
    const row = getTaskById(titleOnlyReminder().id)!
    expect(row.rrule).toBe('FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
    expect(row.labels).not.toContain('ai-to-process')
  })

  test('an explicit rule is respected as sent', () => {
    setDefault(slotId('Evening'))
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'stretch', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9' },
    })
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=9')
  })

  test('an explicit rrule: null is a one-time thought — no default schedule', () => {
    setDefault(slotId('Evening'))
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'one-off thought', is_reminder: true, rrule: null },
    })
    const row = getTaskById(task.id)!
    expect(row.rrule).toBeNull()
    expect(row.due_at).toBeNull()
  })

  test('a plain task (not a reminder) never gets the default', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'buy milk' },
    })
    expect(getTaskById(task.id)!.rrule).toBeNull()
  })

  test('a user with no slots at all keeps the old behavior: unscheduled', () => {
    const db = getDb()
    db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    try {
      const row = getTaskById(titleOnlyReminder().id)!
      expect(row.rrule).toBeNull()
      expect(row.labels).toContain('ai-to-process')
    } finally {
      seedDefaultTimeSlots(TEST_USER_ID)
    }
  })
})

describe('enrichment of a reminder with no time cue', () => {
  test('the prompt marks the default slot, not the current one', async () => {
    setDefault(slotId('Evening'))
    const task = titleOnlyReminder()
    mockEnrichmentQuery.mockResolvedValueOnce(
      aiResult({ rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const prompt = mockEnrichmentQuery.mock.calls[0][0]
    expect(prompt).toMatch(/- Evening — 8:30 PM — BYHOUR=20;BYMINUTE=30 {2}← default slot/)
    expect(prompt.match(/← default slot/g)).toHaveLength(1)
    expect(prompt).not.toContain('current slot')
  })

  test('a rule with no time of day lands in the default slot', async () => {
    setDefault(slotId('Midday'))
    const task = titleOnlyReminder('every friday water the plants')
    mockEnrichmentQuery.mockResolvedValueOnce(
      aiResult({ title: 'Water the plants', rrule: 'FREQ=WEEKLY;BYDAY=FR' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const row = getTaskById(task.id)!
    expect(row.rrule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=12;BYMINUTE=0')
    expect(row.labels).not.toContain('ai-to-process')
  })

  test('a stated time still snaps to the nearest slot, whatever the default', async () => {
    setDefault(slotId('Midday'))
    const task = titleOnlyReminder('in the evening think about the week')
    mockEnrichmentQuery.mockResolvedValueOnce(aiResult({ rrule: 'FREQ=DAILY;BYHOUR=19' }))
    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=20;BYMINUTE=30')
  })

  test('no usable rule from the model → it stays in the default slot', async () => {
    setDefault(slotId('Afternoon'))
    const task = titleOnlyReminder()
    mockEnrichmentQuery.mockResolvedValueOnce(aiResult({ rrule: null }))
    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=16;BYMINUTE=0')
  })

  test('a failed enrichment leaves it in the default slot', async () => {
    setDefault(slotId('Afternoon'))
    const task = titleOnlyReminder()
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('model down'))
    await enrichSingleTask(task.id, TEST_USER_ID)
    // (The label is left for the retry logic — `ai-failed` after two tries.)
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=16;BYMINUTE=0')
  })
})

describe('sanitizeReminderEnrichment — the default slot', () => {
  const slots = () => listTimeSlots(TEST_USER_ID)
  const result = (rrule: string | null): EnrichmentResult => ({
    title: 't',
    due_at: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: 'r',
  })

  test('no stated time → the default slot', () => {
    expect(sanitizeReminderEnrichment(result('FREQ=DAILY'), slots(), 'Evening').rrule).toBe(
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=30',
    )
  })

  test('no default label (or an unknown one) → the first period', () => {
    expect(sanitizeReminderEnrichment(result('FREQ=DAILY'), slots(), null).rrule).toBe(
      'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    )
    expect(sanitizeReminderEnrichment(result('FREQ=DAILY'), slots(), 'Brunch').rrule).toBe(
      'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
    )
  })
})
