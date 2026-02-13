/**
 * Behavioral tests for AI user context
 *
 * Tests getUserAiContext() and prompt construction with/without user context.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import type { TaskSummary } from '@/core/ai/types'

// Mock the SDK to prevent real subprocess spawning
vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { getUserAiContext } from '@/core/ai/user-context'
import { generateWhatsNext } from '@/core/ai/whats-next'
import { getDb } from '@/core/db'
import { aiQuery } from '@/core/ai/sdk'

const mockAiQuery = vi.mocked(aiQuery)

function makeTasks(count: number): TaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    priority: 0,
    due_at: '2026-02-09T15:00:00Z',
    original_due_at: null,
    created_at: '2026-02-01T12:00:00Z',
    labels: [],
    project_name: 'Inbox',
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due' as const,
  }))
}

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  mockAiQuery.mockReset()
  getDb().prepare("DELETE FROM ai_activity_log WHERE action = 'whats_next'").run()
})

describe('getUserAiContext', () => {
  test('returns null for user without ai_context set', () => {
    const result = getUserAiContext(TEST_USER_ID)
    expect(result).toBeNull()
  })

  test('returns the context string when set', () => {
    const db = getDb()
    db.prepare('UPDATE users SET ai_context = ? WHERE id = ?').run(
      'I work from home as a software engineer',
      TEST_USER_ID,
    )

    const result = getUserAiContext(TEST_USER_ID)
    expect(result).toBe('I work from home as a software engineer')

    // Clean up
    db.prepare('UPDATE users SET ai_context = NULL WHERE id = ?').run(TEST_USER_ID)
  })

  test('returns null for non-existent user', () => {
    const result = getUserAiContext(99999)
    expect(result).toBeNull()
  })
})

describe("What's Next prompt includes user context", () => {
  test('includes "User context:" when userContext is provided', async () => {
    mockAiQuery.mockResolvedValue({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'Test reason' }],
        summary: 'Test summary',
        generated_at: '2026-02-09T16:00:00Z',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, makeTasks(3), 'I am a caregiver')

    expect(mockAiQuery).toHaveBeenCalledTimes(1)
    const prompt = mockAiQuery.mock.calls[0][0].prompt as string
    expect(prompt).toContain('User context: I am a caregiver')
  })

  test('does not inject user context line in ## Context section when null', async () => {
    mockAiQuery.mockResolvedValue({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'Test reason' }],
        summary: 'Test summary',
        generated_at: '2026-02-09T16:00:00Z',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, makeTasks(3), null)

    expect(mockAiQuery).toHaveBeenCalledTimes(1)
    const prompt = mockAiQuery.mock.calls[0][0].prompt as string
    // The system prompt mentions "User context:" in guidance text, but the
    // ## Context section should NOT have a "User context:" line with actual content
    const contextSection = prompt.split('## Tasks')[0].split('## Context')[1]
    expect(contextSection).not.toContain('User context:')
  })

  test('does not inject user context line in ## Context section when undefined', async () => {
    mockAiQuery.mockResolvedValue({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'Test reason' }],
        summary: 'Test summary',
        generated_at: '2026-02-09T16:00:00Z',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, makeTasks(3))

    expect(mockAiQuery).toHaveBeenCalledTimes(1)
    const prompt = mockAiQuery.mock.calls[0][0].prompt as string
    const contextSection = prompt.split('## Tasks')[0].split('## Context')[1]
    expect(contextSection).not.toContain('User context:')
  })
})
