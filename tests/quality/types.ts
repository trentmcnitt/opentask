/**
 * Quality test types
 *
 * Shared type definitions for the Layer 1/2 AI quality testing system.
 * Layer 1 (automated) generates outputs and validates structure.
 * Layer 2 (Claude evaluates) judges quality against requirements.
 */

import type { TaskSummary } from '@/core/ai/types'

export interface AITestScenario {
  /** Unique scenario ID, e.g., "enrich-garbled-dictation" */
  id: string
  /** Which AI feature this scenario tests */
  feature:
    | 'enrichment'
    | 'enrichment_reminder'
    | 'enrichment_quota'
    | 'whats_next'
    | 'insights'
    | 'quick_take'
    | 'process_projects'
    | 'process_duplicates'
  /** Human-readable description of what this scenario tests */
  description: string
  /** Input data specific to the feature being tested */
  input:
    | EnrichmentInput
    | ReminderEnrichmentInput
    | QuotaEnrichmentInput
    | WhatsNextInput
    | InsightsInput
    | QuickTakeInput
    | ProcessProjectsInput
    | ProcessDuplicatesInput
  /** Requirements for Layer 1 structural checks and Layer 2 quality evaluation */
  requirements: ScenarioRequirements
}

export interface EnrichmentInput {
  /** Raw task text (what the user typed or dictated) */
  text: string
  /** User's timezone for date conversion */
  timezone: string
  /** Available project names for project matching */
  projects: ProjectInfo[]
  /** Optional user-provided AI context for personalization */
  userContext?: string
  /** User's morning time preference in HH:MM format (default: '09:00') */
  morningTime?: string
  /** User's wake time preference in HH:MM format (default: '07:00') */
  wakeTime?: string
  /** User's sleep time preference in HH:MM format (default: '22:00') */
  sleepTime?: string
  /**
   * The user's reminder periods, in order (default: DEFAULT_TIME_SLOTS) —
   * listed in the prompt for a relative target's period (2026-10-24). In
   * the output, `target_slot_id` is the 1-based position in this list.
   */
  slots?: Array<{ label: string; start_time: string }>
  /**
   * The current moment for this scenario, as a local datetime in `timezone`
   * ("2026-10-16T23:52"). The prompt's "Current local time", every
   * post-process and the `~soon` / `~in-hours` / `~hours-range` matchers all
   * use it. Default: the moment the scenario runs.
   */
  now?: string
}

/**
 * Reminder enrichment input (REDESIGN-V03 §6).
 *
 * A reminder is parsed against the user's editable time slots rather than
 * their workday, so it carries slots instead of morning/wake/sleep times and
 * no projects at all.
 */
export interface ReminderEnrichmentInput {
  /** Raw reminder text (what the user typed or dictated) */
  text: string
  /** User's timezone */
  timezone: string
  /** The user's time slots, in order. Defaults to DEFAULT_TIME_SLOTS. */
  slots?: Array<{ label: string; start_time: string }>
  /**
   * Label of the user's default reminder slot (Settings → Default reminder period),
   * where a thought with no time cue goes.
   */
  defaultSlotLabel?: string
  /** Optional user-provided AI context for personalization */
  userContext?: string
}

/**
 * Quota enrichment input (2026-10-24). A quota is parsed against the user's
 * time slots (its reminder period) and nothing else: no clock, no projects.
 */
export interface QuotaEnrichmentInput {
  /** Raw quota text (what the user typed or dictated) */
  text: string
  /** User's timezone */
  timezone: string
  /** The user's time slots, in order. Defaults to DEFAULT_TIME_SLOTS. */
  slots?: Array<{ label: string; start_time: string }>
  /** Optional user-provided AI context for personalization */
  userContext?: string
}

export interface ProjectInfo {
  id: number
  name: string
  shared: boolean
  /** What belongs there (`projects.description`, up to 280 chars); shown to enrichment when set */
  description?: string | null
}

export interface WhatsNextInput {
  /** Task list sent to What's Next */
  tasks: TaskSummary[]
  /** User's timezone */
  timezone: string
  /** Optional user-provided AI context for personalization */
  userContext?: string
}

export interface InsightsInput {
  /** Task list sent to insights */
  tasks: TaskSummary[]
  /** User's timezone */
  timezone: string
  /** Optional user-provided AI context for personalization */
  userContext?: string
  /** If true, use production processInsightsChunks code path instead of direct AI call */
  useProductionCodePath?: boolean
}

export interface QuickTakeInput {
  /** The title of the newly-created task */
  newTaskTitle: string
  /** User's timezone */
  timezone: string
  /** Existing active tasks for context */
  tasks: TaskSummary[]
}

/**
 * Process — project recommendations (2026-10-10). The same prompt builder and
 * sanitizer as production (`src/core/ai/process.ts`).
 */
export interface ProcessProjectsInput {
  /** Candidate projects (production excludes the Inbox) with their descriptions */
  projects: Array<{ id: number; name: string; description: string | null }>
  tasks: Array<{ id: number; title: string; notes: string | null }>
  userContext?: string
}

/** Process — possible duplicates among open one-off tasks (2026-10-10). */
export interface ProcessDuplicatesInput {
  tasks: Array<{ id: number; title: string; notes: string | null; project_name?: string | null }>
  userContext?: string
}

export interface ScenarioRequirements {
  /** Fields/values that MUST be present in the output */
  must_include?: Record<string, unknown>
  /** Fields/values that must NOT appear in the output */
  must_not_include?: Record<string, unknown>
  /** Guidance for the Layer 2 judge (qualitative expectations) */
  quality_notes?: string
  /** Deterministic insights checks enforced automatically in Layer 1 */
  insights_expectations?: {
    /** task_id -> { min, max } score range */
    score_ranges?: Record<number, { min: number; max: number }>
    /** task_id -> required/forbidden signals */
    signal_checks?: Record<number, { must_have?: string[]; must_not_have?: string[] }>
    /** Minimum % of tasks with zero signals (default 50) */
    min_zero_signal_pct?: number
  }
  /** Deterministic Process checks enforced automatically in Layer 1 */
  process_expectations?: {
    /** task_id -> required project_id (null = must recommend no project or be absent) */
    projects?: Record<number, number | null>
    /** Each listed set of ids must appear together in one group */
    duplicate_groups?: number[][]
    /** No group may contain both ids of a pair */
    not_duplicates?: Array<[number, number]>
  }
}

export interface JudgmentResult {
  /** Overall pass (score >= 6) */
  pass: boolean
  /** Quality score 0-10 */
  score: number
  /** Would a user be satisfied with this output? */
  accept: boolean
  /** Explanation of the judgment */
  reasoning: string
  /** Per-criterion pass/fail results */
  criteria_results: Record<string, boolean>
}

export interface ScenarioOutput {
  /** The scenario ID */
  id: string
  /** Directory path where scenario artifacts are saved */
  dir: string
  /** Whether Layer 1 structural checks passed */
  structuralPass: boolean
  /** Error message if Layer 1 failed */
  error?: string
  /** Duration of the AI query in milliseconds */
  durationMs?: number
}

export interface RunSummary {
  /** Feature being tested */
  feature: string
  /** Model used */
  model: string
  /** Timestamp of the run */
  timestamp: string
  /** Total scenarios attempted */
  total: number
  /** Scenarios that generated output */
  generated: number
  /** Scenarios with structural errors */
  errors: number
  /** Total duration in seconds */
  durationSeconds: number
  /** Per-scenario results */
  scenarios: ScenarioOutput[]
}
