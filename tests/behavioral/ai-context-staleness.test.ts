/**
 * The global AI context's age (task-model redesign, 2026-10-10):
 * `updatePreferences` stamps `ai_context_updated_at` when — and only when —
 * the text changes, and `aiContextStaleness` reads it for the left bar's and
 * the phone menu's warning (stale after AI_CONTEXT_STALE_DAYS, or never stamped).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'
import { getPreferences, updatePreferences } from '@/core/users/preferences'
import {
  AI_CONTEXT_STALE_DAYS,
  aiContextStaleness,
  aiContextStalenessLabel,
  formatAiContextAge,
} from '@/lib/ai-context-staleness'

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ai_context_updated_at is stamped by updatePreferences', () => {
  test('a fresh user has never been stamped', () => {
    expect(getPreferences(TEST_USER_ID).ai_context_updated_at).toBeNull()
  })

  test('setting the context stamps it with now', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    const row = updatePreferences(TEST_USER_ID, { ai_context: 'I work from home.' })
    expect(row.ai_context).toBe('I work from home.')
    expect(row.ai_context_updated_at).toBe('2026-10-01T12:00:00.000Z')
  })

  test('saving the same text leaves the stamp alone', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'))
    const row = updatePreferences(TEST_USER_ID, { ai_context: 'I work from home.' })
    expect(row.ai_context_updated_at).toBe('2026-10-01T12:00:00.000Z')
  })

  test('another preference in the same write does not stamp it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    const row = updatePreferences(TEST_USER_ID, { morning_time: '08:00' })
    expect(row.ai_context_updated_at).toBe('2026-10-01T12:00:00.000Z')
  })

  test('changing the text re-stamps it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T09:30:00Z'))
    const row = updatePreferences(TEST_USER_ID, {
      ai_context: 'I work from home. Two kids.',
      morning_time: '09:00',
    })
    expect(row.ai_context_updated_at).toBe('2026-10-08T09:30:00.000Z')
    expect(row.morning_time).toBe('09:00')
  })

  test('clearing it is a change and stamps it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T09:30:00Z'))
    const row = updatePreferences(TEST_USER_ID, { ai_context: null })
    expect(row.ai_context).toBeNull()
    expect(row.ai_context_updated_at).toBe('2026-10-09T09:30:00.000Z')
  })
})

describe('aiContextStaleness', () => {
  const now = new Date('2026-10-30T12:00:00Z')

  test('never stamped is stale, with or without context', () => {
    expect(aiContextStaleness('ctx', null, now)).toEqual({ ageDays: null, hasContext: true })
    expect(aiContextStaleness(null, null, now)).toEqual({ ageDays: null, hasContext: false })
    expect(aiContextStaleness('   ', null, now)).toEqual({ ageDays: null, hasContext: false })
  })

  test(`fresh until ${AI_CONTEXT_STALE_DAYS} days, stale from then`, () => {
    const day = 24 * 60 * 60 * 1000
    const at = (days: number) => new Date(now.getTime() - days * day).toISOString()
    expect(aiContextStaleness('ctx', at(AI_CONTEXT_STALE_DAYS - 1), now)).toBeNull()
    expect(aiContextStaleness('ctx', at(AI_CONTEXT_STALE_DAYS), now)).toEqual({
      ageDays: AI_CONTEXT_STALE_DAYS,
      hasContext: true,
    })
  })

  test('a recently cleared context is fresh; once old it asks to be added', () => {
    expect(aiContextStaleness(null, '2026-10-29T12:00:00Z', now)).toBeNull()
    const s = aiContextStaleness(null, '2026-09-01T12:00:00Z', now)
    expect(s).not.toBeNull()
    expect(aiContextStalenessLabel(s!)).toBe('Add AI context')
  })

  test('labels', () => {
    expect(aiContextStalenessLabel({ ageDays: 29, hasContext: true })).toBe(
      'AI context: 4 weeks old',
    )
    expect(aiContextStalenessLabel({ ageDays: null, hasContext: true })).toBe('Review AI context')
    expect(aiContextStalenessLabel({ ageDays: null, hasContext: false })).toBe('Add AI context')
  })

  test('formatAiContextAge', () => {
    expect(formatAiContextAge('2026-10-30T08:00:00Z', now)).toBe('today')
    expect(formatAiContextAge('2026-10-29T08:00:00Z', now)).toBe('yesterday')
    expect(formatAiContextAge('2026-10-18T08:00:00Z', now)).toBe('12 days ago')
  })
})
