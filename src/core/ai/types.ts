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
  due_at: z
    .string()
    .nullable()
    .describe('ISO 8601 UTC datetime, or null if no date mentioned')
    .refine((val) => val === null || !isNaN(Date.parse(val)), {
      message: 'due_at must be a valid ISO 8601 datetime',
    }),
  priority: z.number().int().min(0).max(4).describe('0=unset, 1=low, 2=medium, 3=high, 4=urgent'),
  labels: z.array(z.string()).describe('Relevant labels extracted from the text'),
  project_name: z.string().nullable().describe('Suggested project name, or null'),
  rrule: z
    .string()
    .nullable()
    .describe('RFC 5545 RRULE string, or null if not recurring')
    .refine((val) => val === null || val.startsWith('FREQ='), {
      message: 'rrule must be a valid RFC 5545 RRULE string starting with FREQ=',
    }),
  reasoning: z.string().describe('Brief explanation of what was extracted and why'),
})

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>

/**
 * Bubble recommendation schema.
 *
 * Surfaces tasks that would be easily overlooked — not just urgent/overdue items,
 * but things like social obligations, tasks sitting idle, and things that don't
 * have hard deadlines but would become regrets.
 */
export const BubbleResultSchema = z.object({
  tasks: z.array(
    z.object({
      task_id: z.number().describe('ID of the surfaced task'),
      reason: z.string().describe('Why this task was surfaced — what makes it easy to overlook'),
    }),
  ),
  summary: z
    .string()
    .optional()
    .default('Tasks that need your attention')
    .describe('1-2 sentence overview of what needs attention'),
  generated_at: z.string().optional().default('').describe('ISO 8601 generation timestamp'),
})

export type BubbleResult = z.infer<typeof BubbleResultSchema>

/**
 * Daily briefing schema.
 */
export const BriefingResultSchema = z.object({
  greeting: z.string().describe('Conversational greeting, e.g. "Morning Trent — ..."'),
  sections: z.array(
    z.object({
      heading: z.string().describe('Section heading like "Deadlines" or "Shopping"'),
      items: z.array(
        z.object({
          task_id: z.number().nullable().describe('Task ID, or null for summary-only items'),
          text: z.string().describe('Display text for this item'),
          actionable: z.boolean().describe('True if a checkbox should be shown'),
        }),
      ),
    }),
  ),
  generated_at: z.string().describe('ISO 8601 generation timestamp'),
})

export type BriefingResult = z.infer<typeof BriefingResultSchema>

/**
 * AI triage result schema.
 */
export const TriageResultSchema = z.object({
  ordered_task_ids: z
    .array(z.number())
    .describe('Task IDs ordered by importance, most important first'),
  reasoning: z.string().describe('Brief explanation of the ordering rationale'),
})

export type TriageResult = z.infer<typeof TriageResultSchema>

/**
 * Shopping label classification schema.
 */
export const ShoppingLabelResultSchema = z.object({
  section: z
    .string()
    .describe(
      'Store section: produce, dairy, meat, bakery, frozen, pantry, household, personal care, beverages, deli, other',
    ),
  reasoning: z.string().describe('Brief explanation of why this section was chosen'),
})

export type ShoppingLabelResult = z.infer<typeof ShoppingLabelResultSchema>

/**
 * Compact task summary for AI prompts.
 * Includes only the fields AI needs to make decisions.
 */
export interface TaskSummary {
  id: number
  title: string
  priority: number
  due_at: string | null
  labels: string[]
  project_name: string | null
  is_recurring: boolean
  snooze_count: number
}

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
