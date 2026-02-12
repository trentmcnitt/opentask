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
  feature: 'enrichment' | 'bubble' | 'review'
  /** Human-readable description of what this scenario tests */
  description: string
  /** Input data specific to the feature being tested */
  input: EnrichmentInput | BubbleInput | ReviewInput
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
}

export interface ProjectInfo {
  id: number
  name: string
  shared: boolean
}

export interface BubbleInput {
  /** Task list sent to bubble */
  tasks: TaskSummary[]
  /** User's timezone */
  timezone: string
  /** Optional user-provided AI context for personalization */
  userContext?: string
}

export interface ReviewInput {
  /** Task list sent to review */
  tasks: TaskSummary[]
  /** User's timezone */
  timezone: string
  /** Optional user-provided AI context for personalization */
  userContext?: string
}

export interface ScenarioRequirements {
  /** Fields/values that MUST be present in the output */
  must_include?: Record<string, unknown>
  /** Fields/values that must NOT appear in the output */
  must_not_include?: Record<string, unknown>
  /** Guidance for the Layer 2 judge (qualitative expectations) */
  quality_notes?: string
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
