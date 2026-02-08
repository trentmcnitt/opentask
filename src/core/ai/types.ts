/**
 * AI module types and schemas
 *
 * Zod schemas define the structured output format for SDK queries.
 * The enrichment schema is converted to JSON Schema and passed to
 * the SDK's outputFormat option, guaranteeing valid responses.
 */

import { z } from 'zod'

/**
 * Structured output schema for task enrichment.
 *
 * The AI returns this shape when parsing natural language task input.
 * Fields are nullable — the AI only fills in what it can confidently extract.
 * The `reasoning` field explains what was extracted and why (for debugging).
 */
export const EnrichmentResultSchema = z.object({
  title: z.string().describe('Clean, concise task title'),
  due_at: z.string().nullable().describe('ISO 8601 UTC datetime, or null if no date mentioned'),
  priority: z.number().min(0).max(4).describe('0=unset, 1=low, 2=medium, 3=high, 4=urgent'),
  labels: z.array(z.string()).describe('Relevant labels extracted from the text'),
  project_name: z.string().nullable().describe('Suggested project name, or null'),
  rrule: z.string().nullable().describe('RFC 5545 RRULE string, or null if not recurring'),
  reasoning: z.string().describe('Brief explanation of what was extracted and why'),
})

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>

/**
 * Shape of rows in the ai_activity_log table.
 */
export interface AIActivityEntry {
  id?: number
  user_id: number
  task_id: number | null
  action: string
  status: 'success' | 'error' | 'skipped'
  input: string | null
  output: string | null
  model: string | null
  duration_ms: number | null
  error: string | null
  created_at?: string
}
