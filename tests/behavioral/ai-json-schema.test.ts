/**
 * Behavioral tests for CLI JSON Schema normalization
 *
 * Regression guard: Zod's toJSONSchema() emits a `$schema` key naming the
 * 2020-12 draft meta-schema, which the Claude Code CLI's Ajv validator cannot
 * resolve. Passing it through makes the subprocess exit with code 1 before any
 * query runs, silently breaking every SDK-backed AI feature.
 */

import { describe, test, expect } from 'vitest'
import { z } from 'zod'
import { toCliJsonSchema } from '@/core/ai/json-schema'
import {
  EnrichmentResultSchema,
  WhatsNextResultSchema,
  InsightsBatchEnvelopeSchema,
  InsightsBatchResponseSchema,
} from '@/core/ai/types'

describe('toCliJsonSchema', () => {
  test('strips the $schema key that Zod emits', () => {
    const raw = z.toJSONSchema(z.object({ answer: z.string() }))
    expect(raw).toHaveProperty('$schema')

    const normalized = toCliJsonSchema(raw as Record<string, unknown>)
    expect(normalized).not.toHaveProperty('$schema')
  })

  test('preserves all constraint keywords', () => {
    const raw = z.toJSONSchema(
      z.object({ answer: z.string(), count: z.number().int().min(0).max(10) }),
    ) as Record<string, unknown>

    const normalized = toCliJsonSchema(raw)

    expect(normalized.type).toBe('object')
    expect(normalized.required).toEqual(['answer', 'count'])
    expect(normalized.additionalProperties).toBe(false)
    expect(normalized.properties).toEqual(raw.properties)
  })

  test('is a no-op for schemas without $schema', () => {
    const plain = { type: 'object', properties: { a: { type: 'string' } } }
    expect(toCliJsonSchema(plain)).toEqual(plain)
  })

  test('does not mutate the input schema', () => {
    const raw = z.toJSONSchema(z.object({ answer: z.string() })) as Record<string, unknown>
    toCliJsonSchema(raw)
    expect(raw).toHaveProperty('$schema')
  })

  test('production feature schemas are free of $schema after normalization', () => {
    for (const schema of [EnrichmentResultSchema, WhatsNextResultSchema]) {
      const normalized = toCliJsonSchema(z.toJSONSchema(schema) as Record<string, unknown>)
      expect(normalized).not.toHaveProperty('$schema')
    }
  })
})

/**
 * Structured-output schemas become a tool's `input_schema`, which the API
 * requires to have an object root. A root-level array is rejected with
 * `input_schema.type: Input should be 'object'` and the subprocess exits 1.
 */
describe('structured-output schema roots', () => {
  test('every feature schema sent to the CLI has an object root', () => {
    const featureSchemas = {
      enrichment: EnrichmentResultSchema,
      whats_next: WhatsNextResultSchema,
      insights: InsightsBatchEnvelopeSchema,
    }

    for (const [feature, schema] of Object.entries(featureSchemas)) {
      const json = toCliJsonSchema(z.toJSONSchema(schema) as Record<string, unknown>)
      expect(json.type, `${feature} schema root must be an object`).toBe('object')
    }
  })
})

describe('InsightsBatchResponseSchema', () => {
  const item = { task_id: 7, score: 80, commentary: 'Overdue for weeks', signals: ['stale'] }

  test('accepts the wrapped envelope and unwraps it to an array', () => {
    const parsed = InsightsBatchResponseSchema.parse({ tasks: [item] })
    expect(parsed).toEqual([item])
  })

  test('accepts a bare array unchanged', () => {
    expect(InsightsBatchResponseSchema.parse([item])).toEqual([item])
  })

  test('rejects shapes that are neither', () => {
    expect(InsightsBatchResponseSchema.safeParse({ results: [item] }).success).toBe(false)
    expect(InsightsBatchResponseSchema.safeParse({ tasks: 'nope' }).success).toBe(false)
  })
})
