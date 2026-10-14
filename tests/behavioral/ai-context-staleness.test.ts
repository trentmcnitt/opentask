/**
 * The global AI context's age (task-model redesign, 2026-10-10):
 * `updatePreferences` stamps `ai_context_updated_at` when — and only when —
 * the text changes, and Settings › AI reads it for the context's age and its
 * stale emphasis (stale after AI_CONTEXT_STALE_DAYS, or never stamped).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID } from '../helpers/setup'
import { getPreferences, updatePreferences } from '@/core/users/preferences'
import {
  AI_CONTEXT_STALE_DAYS,
  aiContextAgeLabel,
  isAiContextStale,
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

describe('isAiContextStale', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  const day = 24 * 60 * 60 * 1000
  const at = (days: number) => new Date(now.getTime() - days * day).toISOString()

  test('never stamped (or an unreadable stamp) is stale', () => {
    expect(isAiContextStale(null, now)).toBe(true)
    expect(isAiContextStale('not a date', now)).toBe(true)
  })

  test(`fresh until ${AI_CONTEXT_STALE_DAYS} days, stale from then`, () => {
    expect(isAiContextStale(at(0), now)).toBe(false)
    expect(isAiContextStale(at(AI_CONTEXT_STALE_DAYS - 1), now)).toBe(false)
    expect(isAiContextStale(at(AI_CONTEXT_STALE_DAYS), now)).toBe(true)
  })

  test('a stamp a moment after `now` (just marked "Still accurate") is fresh', () => {
    expect(isAiContextStale(new Date(now.getTime() + 500).toISOString(), now)).toBe(false)
  })
})

describe('aiContextAgeLabel', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  const day = 24 * 60 * 60 * 1000
  const at = (days: number) => new Date(now.getTime() - days * day).toISOString()

  test('no stamp reads "No update date"', () => {
    expect(aiContextAgeLabel(null, now)).toBe('No update date')
    expect(aiContextAgeLabel('not a date', now)).toBe('No update date')
  })

  test('days up to two weeks', () => {
    expect(aiContextAgeLabel('2026-10-30T08:00:00Z', now)).toBe('Updated today')
    expect(aiContextAgeLabel(new Date(now.getTime() + 500).toISOString(), now)).toBe(
      'Updated today',
    )
    expect(aiContextAgeLabel('2026-10-29T08:00:00Z', now)).toBe('Updated yesterday')
    expect(aiContextAgeLabel('2026-10-18T08:00:00Z', now)).toBe('Updated 12 days ago')
    expect(aiContextAgeLabel(at(13), now)).toBe('Updated 13 days ago')
  })

  test('weeks up to two months, so the stale threshold reads in weeks', () => {
    expect(aiContextAgeLabel(at(14), now)).toBe('Updated 2 weeks ago')
    expect(aiContextAgeLabel(at(AI_CONTEXT_STALE_DAYS), now)).toBe('Updated 3 weeks ago')
    expect(aiContextAgeLabel(at(25), now)).toBe('Updated 3 weeks ago')
    expect(aiContextAgeLabel(at(59), now)).toBe('Updated 8 weeks ago')
  })

  test('months up to a year, then "over a year"', () => {
    expect(aiContextAgeLabel(at(60), now)).toBe('Updated 2 months ago')
    expect(aiContextAgeLabel(at(364), now)).toBe('Updated 12 months ago')
    expect(aiContextAgeLabel(at(365), now)).toBe('Updated over a year ago')
  })
})
