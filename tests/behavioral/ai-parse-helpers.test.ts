/**
 * Behavioral tests for AI response parsing utilities
 *
 * Tests extractJsonFromText and parseAIResponse from parse-helpers.ts.
 */

import { describe, test, expect } from 'vitest'
import { extractJsonFromText, parseAIResponse } from '@/core/ai/parse-helpers'
import { z } from 'zod'
import type { AIQueryResult } from '@/core/ai/sdk'

const TestSchema = z.object({ value: z.string() })

function makeResult(overrides: Partial<AIQueryResult> = {}): AIQueryResult {
  return {
    structuredOutput: null,
    textResult: null,
    durationMs: 100,
    success: true,
    error: null,
    ...overrides,
  }
}

describe('extractJsonFromText', () => {
  test('returns null for empty string', () => {
    expect(extractJsonFromText('')).toBeNull()
  })

  test('parses json code block', () => {
    const input = '```json\n{"value":"test"}\n```'
    expect(extractJsonFromText(input)).toEqual({ value: 'test' })
  })

  test('parses bare {...} from surrounding text', () => {
    const input = 'Here is the result: {"value":"hello"} end.'
    expect(extractJsonFromText(input)).toEqual({ value: 'hello' })
  })

  test('returns null for malformed JSON', () => {
    expect(extractJsonFromText('{ invalid json }')).toBeNull()
  })
})

describe('parseAIResponse', () => {
  test('returns null when result.success is false', () => {
    const result = makeResult({ success: false, error: 'failed' })
    expect(parseAIResponse(result, TestSchema, 'test')).toBeNull()
  })

  test('parses structured output', () => {
    const result = makeResult({ structuredOutput: { value: 'test' } })
    expect(parseAIResponse(result, TestSchema, 'test')).toEqual({ value: 'test' })
  })

  test('falls back to text when structured output is null', () => {
    const result = makeResult({ textResult: '{"value":"from-text"}' })
    expect(parseAIResponse(result, TestSchema, 'test')).toEqual({ value: 'from-text' })
  })

  test('uses textFallback when structured + JSON parsing both fail', () => {
    const result = makeResult({ textResult: 'not json' })
    const fallback = () => ({ value: 'fallback' })
    expect(parseAIResponse(result, TestSchema, 'test', fallback)).toEqual({ value: 'fallback' })
  })

  test('returns null when everything fails and no textFallback', () => {
    const result = makeResult({ textResult: 'not json' })
    expect(parseAIResponse(result, TestSchema, 'test')).toBeNull()
  })

  test('returns null when both outputs are null', () => {
    const result = makeResult({})
    expect(parseAIResponse(result, TestSchema, 'test')).toBeNull()
  })
})
