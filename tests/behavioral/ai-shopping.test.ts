/**
 * Behavioral tests for shopping list AI labeling
 *
 * Tests the project name heuristic and label classification.
 * SDK is mocked — no real AI calls.
 */

import { describe, test, expect, afterEach, vi } from 'vitest'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { isShoppingProject, getShoppingLabels } from '@/core/ai/shopping'
import { aiQuery } from '@/core/ai/sdk'

const mockAiQuery = vi.mocked(aiQuery)

describe('isShoppingProject', () => {
  test('matches "Shopping List"', () => {
    expect(isShoppingProject('Shopping List')).toBe(true)
  })

  test('matches "Grocery"', () => {
    expect(isShoppingProject('Grocery')).toBe(true)
  })

  test('matches "Groceries"', () => {
    expect(isShoppingProject('Groceries')).toBe(true)
  })

  test('matches partial "shop" in name', () => {
    expect(isShoppingProject('Weekly Shop')).toBe(true)
  })

  test('does not match unrelated project names', () => {
    expect(isShoppingProject('Work')).toBe(false)
    expect(isShoppingProject('Inbox')).toBe(false)
    expect(isShoppingProject('Family')).toBe(false)
  })

  test('case insensitive', () => {
    expect(isShoppingProject('SHOPPING LIST')).toBe(true)
    expect(isShoppingProject('grocery')).toBe(true)
  })
})

describe('getShoppingLabels', () => {
  afterEach(() => {
    mockAiQuery.mockReset()
  })

  test('returns empty array for non-shopping projects', async () => {
    const result = await getShoppingLabels(1, 'Milk', 'Work')
    expect(result).toEqual([])
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test('returns store section label on success', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        section: 'dairy',
        reasoning: 'Milk is a dairy product',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const result = await getShoppingLabels(1, 'Milk', 'Shopping List')
    expect(result).toEqual(['dairy'])
  })

  test('returns empty array on AI failure', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: null,
      durationMs: 100,
      success: false,
      error: 'Timeout',
    })

    const result = await getShoppingLabels(1, 'Bananas', 'Shopping List')
    expect(result).toEqual([])
  })

  test('parses text fallback when structured output is null', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: '{"section": "produce", "reasoning": "Bananas are produce"}',
      durationMs: 100,
      success: true,
      error: null,
    })

    const result = await getShoppingLabels(1, 'Bananas', 'Shopping List')
    expect(result).toEqual(['produce'])
  })
})
