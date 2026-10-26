/**
 * AI module types and schemas
 *
 * Zod schemas define the structured output format for SDK queries.
 * The enrichment schema is converted to JSON Schema and passed to
 * the SDK's outputFormat option, guaranteeing valid responses.
 */

import { z } from 'zod'
import { isValidRRule } from '@/core/recurrence/rrule-builder'
import { HORIZON_ORDER } from '@/lib/task-segments'

/**
 * Structured output schema for task enrichment.
 *
 * The AI returns this shape when parsing natural language task input.
 * Fields are nullable — the AI only fills in what it can confidently extract.
 * The `reasoning` field comes first: the model works the fields out there
 * before it writes them (see the note on it below).
 */
export const EnrichmentResultSchema = z.object({
  // FIRST on purpose (2026-10-20): the model writes the fields in this order,
  // and with no extended thinking a field written before the reasoning is
  // committed before it is worked out. With `reasoning` last, "at noon" said at
  // 10:58 AM came back as tomorrow noon while the reasoning written after it
  // said "noon today is still ahead". The prompt's field list and examples put
  // it first too, so the order agrees everywhere.
  reasoning: z
    .string()
    .describe(
      'Write this FIRST, briefly: work out each field here before filling it in — the day and time to do it (a time with no day: is it still ahead today? a day with no time: the date alone), any cutoff, pace, priority, labels, project, repeat. The fields that follow must match it',
    ),
  title: z.string().describe('Clean, concise task title'),
  due_at: z
    .string()
    .nullable()
    .describe(
      'The day (and time) the user said to do it or be reminded. ISO 8601 local datetime (no Z, no offset) when a time or part of day is stated; the date alone (YYYY-MM-DD) for a day with no time (\"today\", \"tomorrow\", \"do it Saturday\") — the app puts the task on deck for that day; null when no day is mentioned',
    )
    .refine((val) => val === null || !isNaN(new Date(val).getTime()), {
      message: 'due_at must be a valid ISO 8601 datetime',
    }),
  // Task model (2026-10-10). Both default to null so a text-fallback response
  // written without them still parses; in the JSON schema they are required
  // (Zod's output mode), so structured output always carries them.
  deadline_at: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The real outside cutoff the wording states ("by", "expires", "due to the client"). ISO 8601 local datetime, or null',
    )
    .refine((val) => val === null || !isNaN(new Date(val).getTime()), {
      message: 'deadline_at must be a valid ISO 8601 datetime',
    }),
  // RELATIVE TARGETS (2026-10-24, plan §5): a target counted back from the
  // deadline ("the evening before", "2 days before"). Right after deadline_at
  // because they are read from it. Default null like deadline_at, so a text
  // fallback written without them still parses; the code turns the answer
  // into the stored (days, time, period link) — `mapRelativeTarget`
  // (relative-wording.ts). `target_time` is checked with a refine, not a
  // regex: a `pattern` in the structured-output schema is unproven there.
  target_days_before: z
    .number()
    .int()
    .min(0)
    .max(366)
    .nullable()
    .default(null)
    .describe(
      'Only for a target counted back from the deadline: whole days before the deadline\'s day ("the day before" / "the evening before" → 1, "2 days before" → 2, "the morning of" → 0). Otherwise null',
    ),
  target_time: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'With target_days_before: "HH:MM" (24-hour) only when the user said a clock time for it ("at 6pm the day before" → "18:00"); otherwise null',
    )
    .refine((val) => val === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(val), {
      message: 'target_time must be HH:MM',
    }),
  target_period: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'With target_days_before: the part of the day the user said, in their word ("evening", "night", "morning"), written as a listed reminder period\'s exact name when their word is that name; null when they said none',
    ),
  horizon: z
    .enum(HORIZON_ORDER)
    .nullable()
    .default(null)
    .describe('Pace the wording states: days, weeks, months, eventually — or null'),
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
    .describe('Nag interval (said "auto-snooze" before) in minutes. 0 = off. null = unmentioned'),
  recurrence_mode: z
    .enum(['from_due', 'from_completion'])
    .nullable()
    .describe('"from_completion" only if user explicitly says so. null = unmentioned'),
  notes: z
    .string()
    .nullable()
    .describe('Context/details extracted from dictation, separate from the title'),
  // QUOTA ENRICHMENT (2026-10-24, plan-quota-enrichment §3). A quota is
  // enriched through this same schema — the warm slot pins one — so its count
  // and period travel in fields of their own: a bare quota period
  // (`FREQ=WEEKLY`) is not a valid task rule (`isValidRRule` wants BYDAY), so
  // it could not ride in `rrule`. Last in the object, and default null like
  // deadline_at, so a text-fallback answer written without them still parses;
  // structured output always carries them. Only the quota user prompt
  // (`buildQuotaEnrichmentUserPrompt`) fills them; the task and reminder
  // sanitizers null them (`withoutQuotaFields`).
  quota_target: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .nullable()
    .default(null)
    .describe('Quota only: how many times per period. null for a task or reminder'),
  quota_period: z
    .enum(['day', 'week', 'month', 'year'])
    .nullable()
    .default(null)
    .describe('Quota only: the period the count is per. null for a task or reminder, or unsaid'),
  quota_interval: z
    .number()
    .int()
    .min(1)
    .max(366)
    .nullable()
    .default(null)
    .describe(
      'Quota only: how many periods one count spans ("every 2 weeks" → 2). null for a task or reminder, or 1',
    ),
  quota_prompt_time: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Quota only: the time slot label (or HH:MM) the user asked to be reminded at. null if unsaid, and for a task or reminder',
    ),
  quota_prompt_enabled: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      'Quota only: false for "don\'t remind me", true for an explicit "remind me". null otherwise, and for a task or reminder',
    ),
})

/**
 * The model's answer, plus what the post-process derives from it. ON DECK
 * (2026-10-20, spec rule 11): a day with no time ("do it Saturday", "today",
 * "tomorrow") comes back from the model as a bare date in `due_at`, and
 * `resolveDeckDay` (enrichment.ts) moves it here — a local calendar day
 * (yyyy-MM-dd), with `due_at` null. It is NOT in the schema the model sees:
 * the model only ever writes a bare date, and the code decides the deck.
 */
export type EnrichmentResult = Omit<
  OptionalQuotaFields<z.infer<typeof EnrichmentResultSchema>>,
  'target_days_before' | 'target_time' | 'target_period'
> & {
  // Relative targets (2026-10-24): optional here (the schema always fills
  // them, null), so an answer built in code without them still types. The
  // quota fields likewise (`OptionalQuotaFields`, below).
  target_days_before?: number | null
  target_time?: string | null
  target_period?: string | null
  on_deck_day?: string | null
  /**
   * RELATIVE TARGETS (2026-10-24): the reminder period the relative target's
   * time follows, or null for a custom time — set by `mapRelativeTarget`
   * from `target_period` (then `target_time` is that period's start). Not in
   * the schema: the model names a period, the code links it.
   */
  target_slot_id?: number | null
}

/** The quota answer fields (quota enrichment, 2026-10-24). */
export const QUOTA_ANSWER_FIELDS = [
  'quota_target',
  'quota_period',
  'quota_interval',
  'quota_prompt_time',
  'quota_prompt_enabled',
] as const

/**
 * The quota fields optional in the TYPE (the schema always fills them, null):
 * an answer built in code for a task or reminder need not spell them out.
 */
type OptionalQuotaFields<T> = Omit<T, (typeof QUOTA_ANSWER_FIELDS)[number]> &
  Partial<Pick<T, Extract<keyof T, (typeof QUOTA_ANSWER_FIELDS)[number]>>>

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
  /**
   * Task model (2026-10-10). `due_at` above is the TARGET; this is the real
   * cutoff. Optional so hand-written quality scenarios that predate the field
   * still type-check — absent reads as "no deadline".
   */
  deadline_at?: string | null
  /** Pace: days | weeks | months | eventually. Absent/null = not set. */
  horizon?: 'days' | 'weeks' | 'months' | 'eventually' | null
  /**
   * True when `due_at` is the deadline's AUTOMATIC target (`target_auto`, §8),
   * not one the user set. Printed "(from deadline)".
   */
  target_implied?: boolean
  /**
   * On deck (2026-10-20): the local day (yyyy-MM-dd) the user plans to get to
   * it, with no nag — a plan, not a forgotten task. Printed "on deck:".
   */
  on_deck_day?: string | null
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

/**
 * Wire-format schema for insights structured output.
 *
 * Insights is conceptually a list, but a bare array cannot be used as the
 * structured-output schema: the provider turns it into a tool's `input_schema`,
 * which must be an object. A root-level array is rejected with
 * `input_schema.type: Input should be 'object'`, and the Claude Code subprocess
 * exits with code 1 before producing anything. So the array travels wrapped.
 */
export const InsightsBatchEnvelopeSchema = z.object({
  tasks: InsightsBatchResultSchema.describe('One entry per reviewed task'),
})

/**
 * Parsing schema for insights responses, normalizing to a plain array.
 *
 * Accepts the wrapped envelope (structured output) or a bare array (text
 * responses, which are not bound by the object-root constraint).
 */
export const InsightsBatchResponseSchema = z.union([
  InsightsBatchResultSchema,
  InsightsBatchEnvelopeSchema.transform((envelope) => envelope.tasks),
])

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
