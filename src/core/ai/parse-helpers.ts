/**
 * Shared AI response parsing utilities
 *
 * Extracted as a standalone module so test mocks of `./sdk` don't
 * inadvertently shadow the function (vi.mock replaces the whole module).
 */

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
