/**
 * AI module types and schemas
 *
 * Zod schemas define the structured output format for SDK queries.
 * The enrichment schema is converted to JSON Schema and passed to
 * the SDK's outputFormat option, guaranteeing valid responses.
 */

import { z } from 'zod'
import { isValidRRule } from '@/core/recurrence/rrule-builder'

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
    .describe('ISO 8601 local datetime (no Z, no offset), or null if no date mentioned')
    .refine((val) => val === null || !isNaN(new Date(val).getTime()), {
      message: 'due_at must be a valid ISO 8601 datetime',
    }),
  priority: z.number().int().min(0).max(4).describe('0=unset, 1=low, 2=medium, 3=high, 4=urgent'),
  labels: z.array(z.string()).describe('Relevant labels extracted from the text'),
  project_name: z.string().nullable().describe('Suggested project name, or null'),
  rrule: z
    .string()
    .nullable()
    .describe('RFC 5545 RRULE string, or null if not recurring')
    .refine((val) => val === null || isValidRRule(val), {
      message: 'rrule must be a valid RFC 5545 RRULE string',
    }),
  auto_snooze_minutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .nullable()
    .describe('Auto-snooze in minutes. 0 = off. null = unmentioned'),
  recurrence_mode: z
    .enum(['from_due', 'from_completion'])
    .nullable()
    .describe('"from_completion" only if user explicitly says so. null = unmentioned'),
  notes: z
    .string()
    .nullable()
    .describe('Context/details extracted from dictation, separate from the title'),
  reasoning: z.string().describe('Brief explanation of what was extracted and why'),
})

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>

/**
 * What's Next recommendation schema.
 *
 * Helps the user decide what to focus on next — surfacing tasks that
 * deserve attention, are easy to forget, or represent opportunities
 * to make meaningful progress.
 */
export const WhatsNextResultSchema = z.object({
  tasks: z.array(
    z.object({
      task_id: z.number().describe('ID of the surfaced task'),
      reason: z.string().describe('Why this task deserves attention right now'),
    }),
  ),
  summary: z
    .string()
    .optional()
    .default('Tasks that need your attention')
    .describe('1-2 sentence overview of what needs attention'),
  generated_at: z.string().optional().default('').describe('ISO 8601 generation timestamp'),
})

export type WhatsNextResult = z.infer<typeof WhatsNextResultSchema>

/**
 * Compact task summary for AI prompts.
 * Includes only the fields AI needs to make decisions.
 *
 * Dates are stored as ISO UTC here and converted to human-readable
 * local time when building the prompt (see format.ts).
 */
export interface TaskSummary {
  id: number
  title: string
  priority: number
  due_at: string | null
  original_due_at: string | null
  created_at: string
  labels: string[]
  project_name: string | null
  is_recurring: boolean
  rrule: string | null
  notes: string | null
  recurrence_mode: 'from_due' | 'from_completion'
}

/**
 * AI insights result schema.
 *
 * Each task gets a score (0-100), one-line commentary, and 0-2 signals
 * from a preset vocabulary. Used for batch insights of the entire task list.
 */
export const INSIGHTS_SIGNAL_KEYS = [
  'review',
  'stale',
  'act_soon',
  'quick_win',
  'vague',
  'misprioritized',
] as const

export type InsightsSignalKey = (typeof INSIGHTS_SIGNAL_KEYS)[number]

export const InsightsItemSchema = z.object({
  task_id: z.number().describe('ID of the reviewed task'),
  score: z.number().int().min(0).max(100).describe('0-100 attention score'),
  commentary: z.string().describe('One-line reason for the score'),
  signals: z
    .array(z.enum(INSIGHTS_SIGNAL_KEYS))
    .max(2)
    .default([])
    .describe('0-2 signal keys from the preset vocabulary'),
})

export const InsightsBatchResultSchema = z.array(InsightsItemSchema)

export type InsightsItem = z.infer<typeof InsightsItemSchema>

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
  provider?: string | null
  created_at?: string
}
