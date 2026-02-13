/**
 * Shared AI response parsing utilities
 *
 * Extracted as a standalone module so test mocks of `./sdk` don't
 * inadvertently shadow the function (vi.mock replaces the whole module).
 */

import type { ZodSchema } from 'zod'
import type { AIQueryResult } from './sdk'
import { log } from '@/lib/logger'

/**
 * Generic AI response parser.
 *
 * Handles the shared pattern across all AI features:
 * 1. Check result.success
 * 2. Try structuredOutput first
 * 3. Fall back to extracting JSON from textResult
 * 4. Validate with Zod schema
 * 5. Optionally try a text-based fallback parser
 * 6. Return null if everything fails
 *
 * @param result - The AIQueryResult from aiQuery()
 * @param schema - Zod schema to validate the parsed output
 * @param action - Feature name for log messages (e.g., 'enrichment', 'whats_next')
 * @param textFallback - Optional function to parse markdown/text output when JSON parsing fails
 */
export function parseAIResponse<T>(
  result: AIQueryResult,
  schema: ZodSchema<T>,
  action: string,
  textFallback?: (text: string) => T | null,
): T | null {
  if (!result.success) {
    log.error('ai', `${action} failed:`, result.error)
    return null
  }

  if (!result.structuredOutput && !result.textResult) {
    log.error('ai', `${action} returned empty output (no structured or text result)`)
    return null
  }

  let output = result.structuredOutput
  if (!output && result.textResult) {
    output = extractJsonFromText(result.textResult)
  }

  const parsed = schema.safeParse(output)

  if (!parsed.success && result.textResult && textFallback) {
    const fallbackResult = textFallback(result.textResult)
    if (fallbackResult) return fallbackResult
    log.error('ai', `Invalid ${action} output:`, parsed.error.message)
    return null
  }

  if (!parsed.success) {
    log.error('ai', `${action}: ${output ? 'invalid output' : 'no output to parse'}`)
    return null
  }

  return parsed.data
}

/**
 * Extract a JSON object from a text response that may contain markdown
 * code blocks or other surrounding text. The SDK sometimes returns text
 * with embedded JSON instead of using the structured output channel.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try the full text as JSON first
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not pure JSON
  }

  // Try extracting from a ```json code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]) as Record<string, unknown>
    } catch {
      // Invalid JSON in code block
    }
  }

  // Try finding the first { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>
    } catch {
      // Invalid JSON
    }
  }

  return null
}
