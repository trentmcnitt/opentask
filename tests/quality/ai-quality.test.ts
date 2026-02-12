/**
 * AI Quality Tests — Layer 1 (Automated Generation + Structural Validation)
 *
 * Runs each test scenario through the real AI using the same production code
 * paths. Saves inputs, outputs, and requirements to disk for Layer 2 evaluation.
 *
 * Layer 1 validates structure (JSON parses, schema validates, required fields present).
 * Layer 2 (Claude in-session) evaluates quality by reading the saved artifacts.
 *
 * Requirements:
 * - OPENTASK_AI_ENABLED=true
 * - Claude CLI installed and authenticated
 *
 * Run with: npm run test:quality
 */

import { describe, test, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { allScenarios } from './scenarios/index'
import type {
  AITestScenario,
  EnrichmentInput,
  BubbleInput,
  ReviewInput,
  ScenarioOutput,
  RunSummary,
} from './types'

// ---------------------------------------------------------------------------
// Skip all tests if AI is not enabled
// ---------------------------------------------------------------------------

const AI_ENABLED = process.env.OPENTASK_AI_ENABLED === 'true'

// ---------------------------------------------------------------------------
// Quality test user ID
//
// aiQuery() logs activity to the ai_activity_log table, which has a foreign
// key constraint on user_id. We create a dedicated test user in beforeAll.
// ---------------------------------------------------------------------------

const QUALITY_TEST_USER_ID = 999

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

let runDir: string
const scenarioResults: ScenarioOutput[] = []
const startTime = Date.now()

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!AI_ENABLED) return

  // Ensure a test user exists for activity logging (FK constraint on user_id).
  // getDb() auto-creates the database and applies the schema on first call.
  const { getDb } = await import('@/core/db')
  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(QUALITY_TEST_USER_ID)
  if (!existing) {
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, timezone)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      QUALITY_TEST_USER_ID,
      'quality-test@test.local',
      'quality-test',
      'not-a-real-hash',
      'America/Chicago',
    )
  }

  // Create output directory: test-results/quality-{timestamp}/
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  runDir = path.resolve('test-results', `quality-${timestamp}`)
  fs.mkdirSync(runDir, { recursive: true })

  // Create latest symlink for convenience
  const latestLink = path.resolve('test-results', 'latest-quality')
  try {
    if (fs.existsSync(latestLink)) fs.unlinkSync(latestLink)
    fs.symlinkSync(runDir, latestLink)
  } catch {
    // Symlink creation may fail on some platforms — non-fatal
  }
})

afterAll(() => {
  if (!AI_ENABLED || !runDir) return

  const durationSeconds = Math.round((Date.now() - startTime) / 1000)
  const generated = scenarioResults.filter((r) => !r.error).length
  const errors = scenarioResults.filter((r) => r.error).length

  // Write summary.json
  const summary: RunSummary = {
    feature: 'all',
    model: process.env.OPENTASK_AI_ENRICHMENT_MODEL || 'haiku',
    timestamp: new Date().toISOString(),
    total: scenarioResults.length,
    generated,
    errors,
    durationSeconds,
    scenarios: scenarioResults,
  }

  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  // Print Layer 2 banner
  console.log(`
======================================================================
  LAYER 1 COMPLETE — LAYER 2 VALIDATION REQUIRED
======================================================================

  Feature:   all (enrichment, bubble, review)
  Model:     ${summary.model}
  Generated: ${generated}/${summary.total} outputs (${errors} errors)
  Duration:  ${durationSeconds}s total
  Output:    ${runDir}

  Layer 1 (generation + structural checks) is just a sanity check.
  Layer 2 is the ACTUAL quality test.

  PROCEED WITH LAYER 2 VALIDATION:
  1. Read the validator prompt: tests/quality/validator-prompt.md
  2. For each scenario in the output directory:
     - Read input.json (what was sent to the AI)
     - Read output.json (what the AI returned)
     - Read requirements.json (what counts as good)
     - Evaluate against the validator prompt criteria
     - Save your judgment to the scenario dir as validation.md
  3. Write an overall summary to the run directory as layer2-summary.md
  4. Report results to the user.

  Validate EVERY scenario. Do not spot-check.
======================================================================
`)
})

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

describe('AI Quality — Layer 1', () => {
  test.skipIf(!AI_ENABLED)('AI must be enabled (set OPENTASK_AI_ENABLED=true)', () => {
    // This test only runs to display the skip message
  })

  // -------------------------------------------------------------------------
  // Enrichment scenarios
  // -------------------------------------------------------------------------

  describe('Enrichment', () => {
    const enrichmentTests = allScenarios.filter((s) => s.feature === 'enrichment')

    for (const scenario of enrichmentTests) {
      test.skipIf(!AI_ENABLED)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Bubble scenarios
  // -------------------------------------------------------------------------

  describe('Bubble', () => {
    const bubbleTests = allScenarios.filter((s) => s.feature === 'bubble')

    for (const scenario of bubbleTests) {
      test.skipIf(!AI_ENABLED)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Review scenarios
  // -------------------------------------------------------------------------

  describe('Review', () => {
    const reviewTests = allScenarios.filter((s) => s.feature === 'review')

    for (const scenario of reviewTests) {
      test.skipIf(!AI_ENABLED)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

async function runScenario(scenario: AITestScenario): Promise<void> {
  const scenarioDir = path.join(runDir, scenario.id)
  fs.mkdirSync(scenarioDir, { recursive: true })

  // Save input and requirements
  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify(
      {
        feature: scenario.feature,
        description: scenario.description,
        ...scenario.input,
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(scenario.requirements, null, 2),
  )

  try {
    let output: Record<string, unknown>
    let durationMs: number

    switch (scenario.feature) {
      case 'enrichment':
        ;({ output, durationMs } = await runEnrichment(scenario.input as EnrichmentInput))
        break
      case 'bubble':
        ;({ output, durationMs } = await runBubble(scenario.input as BubbleInput))
        break
      case 'review':
        ;({ output, durationMs } = await runReview(scenario.input as ReviewInput))
        break
    }

    // Save output
    fs.writeFileSync(path.join(scenarioDir, 'output.json'), JSON.stringify(output, null, 2))

    // Save metadata
    fs.writeFileSync(
      path.join(scenarioDir, 'metadata.json'),
      JSON.stringify(
        {
          scenario_id: scenario.id,
          feature: scenario.feature,
          model: getModelForFeature(scenario.feature),
          duration_ms: durationMs,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    )

    // Structural assertions
    validateStructure(scenario, output)

    scenarioResults.push({
      id: scenario.id,
      dir: scenarioDir,
      structuralPass: true,
      durationMs,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    // Save error
    fs.writeFileSync(
      path.join(scenarioDir, 'error.json'),
      JSON.stringify({ error: errorMessage, timestamp: new Date().toISOString() }, null, 2),
    )

    scenarioResults.push({
      id: scenario.id,
      dir: scenarioDir,
      structuralPass: false,
      error: errorMessage,
    })

    throw err
  }
}

// ---------------------------------------------------------------------------
// Feature runners — use the same production code paths
// ---------------------------------------------------------------------------

async function runEnrichment(
  input: EnrichmentInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { ENRICHMENT_SYSTEM_PROMPT } = await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { EnrichmentResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')

  const projectList = input.projects
    .map((p) => `- ${p.name} (id: ${p.id}${p.shared ? ', shared' : ''})`)
    .join('\n')

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${ENRICHMENT_SYSTEM_PROMPT}

## Context

User's timezone: ${input.timezone}
Current UTC time: ${new Date().toISOString()}

Available projects:
${projectList}${userContextBlock}

## Task to parse

"${input.text}"

Parse this task and return the structured result.`

  const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_ENRICHMENT_MODEL || 'haiku',
    maxTurns: 1,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_enrich',
    inputText: input.text,
  })

  // Use parseAIResponse with text fallback — the SDK often returns JSON
  // wrapped in markdown code blocks rather than structured_output
  const parsed = parseAIResponse(result, EnrichmentResultSchema, 'Enrichment', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const attempt = EnrichmentResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`AI query failed: ${result.error || 'No output'}`)
  }

  return { output: parsed as unknown as Record<string, unknown>, durationMs: result.durationMs }
}

async function runBubble(
  input: BubbleInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { BUBBLE_SYSTEM_PROMPT } = await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { BubbleResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')

  const { DateTime } = await import('luxon')
  const now = DateTime.now().setZone(input.timezone)

  const formatLocal = (iso: string) =>
    DateTime.fromISO(iso, { zone: 'utc' }).setZone(input.timezone).toFormat('ccc, LLL d, h:mm a')

  const taskList = input.tasks
    .map((t) => {
      const due = t.due_at ? formatLocal(t.due_at) : 'none'
      // Only show original_due_at for P3-4 (deliberate changes); P0-2 gap is bulk-snooze noise
      const originalDue =
        t.priority >= 3 && t.original_due_at && t.original_due_at !== t.due_at
          ? ` (originally due: ${formatLocal(t.original_due_at)})`
          : ''
      const created = formatLocal(t.created_at)
      const rrule = t.rrule ? `rrule: ${t.rrule}` : 'one-off'
      const recMode =
        t.recurrence_mode !== 'from_due' ? ` | recurrence_mode: ${t.recurrence_mode}` : ''
      const notes = t.notes ? ` | notes: ${t.notes}` : ''
      return (
        `- [${t.id}] "${t.title}" | priority: ${t.priority} | due: ${due}${originalDue} | ` +
        `created: ${created} | labels: ${t.labels.join(', ') || 'none'} | ` +
        `project: ${t.project_name || 'Inbox'} | ${rrule}${recMode}${notes}`
      )
    })
    .join('\n')

  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${BUBBLE_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total active tasks: ${input.tasks.length}${userContextBlock}

## Tasks

${taskList}

Analyze these tasks and surface 3-7 that are easy to overlook but deserve attention.`

  const jsonSchema = z.toJSONSchema(BubbleResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_BUBBLE_MODEL || 'haiku',
    maxTurns: 1,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_bubble',
    inputText: `${input.tasks.length} tasks`,
  })

  // Use the same parsing + normalization as production bubble.ts
  const parsed = parseAIResponse(result, BubbleResultSchema, 'Bubble', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    if ('tasks_to_surface' in json && !('tasks' in json)) {
      json.tasks = json.tasks_to_surface
      delete json.tasks_to_surface
    }
    if (!json.generated_at) {
      json.generated_at = new Date().toISOString()
    }
    const attempt = BubbleResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`Bubble query failed: ${result.error || 'Could not parse output'}`)
  }

  return { output: parsed as unknown as Record<string, unknown>, durationMs: result.durationMs }
}

async function runReview(
  input: ReviewInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { REVIEW_SYSTEM_PROMPT } = await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { ReviewBatchResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')
  const { DateTime } = await import('luxon')

  const now = DateTime.now().setZone(input.timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  const formatLocal = (iso: string) =>
    DateTime.fromISO(iso, { zone: 'utc' }).setZone(input.timezone).toFormat('ccc, LLL d, h:mm a')

  const formatAge = (iso: string) => {
    const dt = DateTime.fromISO(iso, { zone: 'utc' })
    const days = Math.floor(now.diff(dt, 'days').days)
    if (days <= 0) return 'today'
    if (days === 1) return '1 day ago'
    if (days < 7) return `${days} days ago`
    const weeks = Math.floor(days / 7)
    if (days < 30) return `${weeks} week${weeks > 1 ? 's' : ''} ago`
    const months = Math.floor(days / 30)
    return `${months} month${months > 1 ? 's' : ''} ago`
  }

  const taskLines = input.tasks
    .map((t) => {
      const due = t.due_at ? formatLocal(t.due_at) : 'none'
      const originalDue =
        t.priority >= 3 && t.original_due_at && t.original_due_at !== t.due_at
          ? ` (originally due: ${formatLocal(t.original_due_at)})`
          : ''
      const created = formatLocal(t.created_at)
      const createdAge = formatAge(t.created_at)
      const rrule = t.rrule ? `rrule: ${t.rrule}` : 'one-off'
      const recMode =
        t.recurrence_mode !== 'from_due' ? ` | recurrence_mode: ${t.recurrence_mode}` : ''
      const notes = t.notes ? ` | notes: ${t.notes}` : ''
      return (
        `- [${t.id}] "${t.title}" | priority: ${t.priority} | due: ${due}${originalDue} | ` +
        `created: ${created} (${createdAge}) | labels: ${t.labels.join(', ') || 'none'} | ` +
        `project: ${t.project_name || 'Inbox'} | ${rrule}${recMode}${notes}`
      )
    })
    .join('\n')

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${REVIEW_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total tasks in full list: ${input.tasks.length}
Tasks in this batch: ${input.tasks.length}${userContextBlock}

## Tasks

${taskLines}

Score every task in this batch. Return a JSON array with one entry per task.`

  const jsonSchema = z.toJSONSchema(ReviewBatchResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_REVIEW_MODEL || 'haiku',
    maxTurns: 1,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_review',
    inputText: `${input.tasks.length} tasks`,
  })

  const parsed = parseAIResponse(result, ReviewBatchResultSchema, 'Review', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const arr = Array.isArray(json) ? json : json.tasks
    if (!Array.isArray(arr)) return null
    const attempt = ReviewBatchResultSchema.safeParse(arr)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`Review query failed: ${result.error || 'Could not parse output'}`)
  }

  // Wrap the array in an object for consistent output handling
  return {
    output: { items: parsed } as unknown as Record<string, unknown>,
    durationMs: result.durationMs,
  }
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

function validateStructure(scenario: AITestScenario, output: Record<string, unknown>): void {
  const { must_include, must_not_include } = scenario.requirements

  // Check must_include fields
  if (must_include) {
    for (const [key, expectedValue] of Object.entries(must_include)) {
      const actualValue = output[key]

      if (expectedValue === null) {
        // Must be null or undefined
        if (actualValue != null) {
          throw new Error(
            `[${scenario.id}] Expected ${key} to be null, got ${JSON.stringify(actualValue)}`,
          )
        }
      } else if (typeof expectedValue === 'number') {
        if (actualValue !== expectedValue) {
          throw new Error(
            `[${scenario.id}] Expected ${key} = ${expectedValue}, got ${JSON.stringify(actualValue)}`,
          )
        }
      } else if (typeof expectedValue === 'string') {
        if (
          typeof actualValue !== 'string' ||
          actualValue.toLowerCase() !== expectedValue.toLowerCase()
        ) {
          throw new Error(
            `[${scenario.id}] Expected ${key} = "${expectedValue}", got ${JSON.stringify(actualValue)}`,
          )
        }
      } else if (Array.isArray(expectedValue)) {
        // Array-contains check: every element in expectedValue must be present in actualValue
        if (!Array.isArray(actualValue)) {
          throw new Error(
            `[${scenario.id}] Expected ${key} to be an array, got ${typeof actualValue}`,
          )
        }
        const actualLower = (actualValue as string[]).map((v) =>
          typeof v === 'string' ? v.toLowerCase() : v,
        )
        for (const expected of expectedValue) {
          const needle = typeof expected === 'string' ? expected.toLowerCase() : expected
          if (!actualLower.includes(needle)) {
            throw new Error(
              `[${scenario.id}] Expected ${key} to include ${JSON.stringify(expected)}, got ${JSON.stringify(actualValue)}`,
            )
          }
        }
      }
    }
  }

  // Check must_not_include fields
  if (must_not_include) {
    for (const [key, forbiddenValue] of Object.entries(must_not_include)) {
      const actualValue = output[key]
      if (Array.isArray(forbiddenValue) && Array.isArray(actualValue)) {
        // Array-excludes check: none of the forbidden elements may be in actualValue
        const actualLower = (actualValue as string[]).map((v) =>
          typeof v === 'string' ? v.toLowerCase() : v,
        )
        for (const forbidden of forbiddenValue) {
          const needle = typeof forbidden === 'string' ? forbidden.toLowerCase() : forbidden
          if (actualLower.includes(needle)) {
            throw new Error(
              `[${scenario.id}] ${key} must NOT include ${JSON.stringify(forbidden)}, but it does`,
            )
          }
        }
      } else if (actualValue === forbiddenValue) {
        throw new Error(
          `[${scenario.id}] ${key} must NOT be ${JSON.stringify(forbiddenValue)}, but it is`,
        )
      }
    }
  }

  // Feature-specific schema validation
  switch (scenario.feature) {
    case 'enrichment':
      validateEnrichmentSchema(scenario.id, output)
      break
    case 'bubble':
      validateBubbleSchema(scenario.id, output)
      break
    case 'review':
      validateReviewSchema(scenario.id, output, scenario.input as ReviewInput)
      break
  }
}

function validateEnrichmentSchema(id: string, output: Record<string, unknown>): void {
  if (typeof output.title !== 'string' || output.title.length === 0) {
    throw new Error(`[${id}] title must be a non-empty string`)
  }
  if (typeof output.priority !== 'number' || output.priority < 0 || output.priority > 4) {
    throw new Error(`[${id}] priority must be 0-4, got ${output.priority}`)
  }
  if (!Array.isArray(output.labels)) {
    throw new Error(`[${id}] labels must be an array`)
  }
  if (output.due_at !== null && typeof output.due_at !== 'string') {
    throw new Error(`[${id}] due_at must be a string or null`)
  }
  if (output.due_at !== null && isNaN(Date.parse(output.due_at as string))) {
    throw new Error(`[${id}] due_at is not a valid ISO 8601 date: ${output.due_at}`)
  }
  if (output.rrule !== null && typeof output.rrule !== 'string') {
    throw new Error(`[${id}] rrule must be a string or null`)
  }
  if (output.rrule !== null && !(output.rrule as string).startsWith('FREQ=')) {
    throw new Error(`[${id}] rrule must start with FREQ=, got: ${output.rrule}`)
  }
  // auto_snooze_minutes: integer 0-1440 or null
  if (output.auto_snooze_minutes !== null && output.auto_snooze_minutes !== undefined) {
    if (
      typeof output.auto_snooze_minutes !== 'number' ||
      !Number.isInteger(output.auto_snooze_minutes)
    ) {
      throw new Error(
        `[${id}] auto_snooze_minutes must be an integer or null, got ${output.auto_snooze_minutes}`,
      )
    }
    if (
      (output.auto_snooze_minutes as number) < 0 ||
      (output.auto_snooze_minutes as number) > 1440
    ) {
      throw new Error(
        `[${id}] auto_snooze_minutes must be 0-1440, got ${output.auto_snooze_minutes}`,
      )
    }
  }
  // recurrence_mode: "from_due" | "from_completion" or null
  if (output.recurrence_mode !== null && output.recurrence_mode !== undefined) {
    if (output.recurrence_mode !== 'from_due' && output.recurrence_mode !== 'from_completion') {
      throw new Error(
        `[${id}] recurrence_mode must be "from_due", "from_completion", or null, got ${JSON.stringify(output.recurrence_mode)}`,
      )
    }
  }
  // notes: string or null
  if (output.notes !== null && output.notes !== undefined) {
    if (typeof output.notes !== 'string') {
      throw new Error(`[${id}] notes must be a string or null, got ${typeof output.notes}`)
    }
  }
}

function validateBubbleSchema(id: string, output: Record<string, unknown>): void {
  if (!Array.isArray(output.tasks)) {
    throw new Error(`[${id}] tasks must be an array`)
  }
  for (const task of output.tasks as Array<Record<string, unknown>>) {
    if (typeof task.task_id !== 'number') {
      throw new Error(`[${id}] each task must have a numeric task_id`)
    }
    if (typeof task.reason !== 'string' || task.reason.length === 0) {
      throw new Error(`[${id}] each task must have a non-empty reason`)
    }
  }
  if (typeof output.summary !== 'string') {
    throw new Error(`[${id}] summary must be a string`)
  }
}

function validateReviewSchema(
  id: string,
  output: Record<string, unknown>,
  input: ReviewInput,
): void {
  const items = output.items as Array<Record<string, unknown>>
  if (!Array.isArray(items)) {
    throw new Error(`[${id}] items must be an array`)
  }

  const inputTaskIds = new Set(input.tasks.map((t) => t.id))
  const VALID_SIGNALS = ['review', 'stale', 'act_soon', 'quick_win', 'vague', 'misprioritized']

  for (const item of items) {
    if (typeof item.task_id !== 'number') {
      throw new Error(`[${id}] each item must have a numeric task_id`)
    }
    if (!inputTaskIds.has(item.task_id)) {
      throw new Error(`[${id}] task_id ${item.task_id} was not in the input task list`)
    }
    if (typeof item.score !== 'number' || item.score < 0 || item.score > 100) {
      throw new Error(`[${id}] task ${item.task_id}: score must be 0-100, got ${item.score}`)
    }
    if (typeof item.commentary !== 'string' || item.commentary.length === 0) {
      throw new Error(`[${id}] task ${item.task_id}: commentary must be a non-empty string`)
    }
    if (Array.isArray(item.signals)) {
      if (item.signals.length > 2) {
        throw new Error(
          `[${id}] task ${item.task_id}: max 2 signals allowed, got ${item.signals.length}`,
        )
      }
      for (const sig of item.signals as string[]) {
        if (!VALID_SIGNALS.includes(sig)) {
          throw new Error(`[${id}] task ${item.task_id}: invalid signal "${sig}"`)
        }
      }
    }
  }

  // Every input task should have a result
  const outputTaskIds = new Set(items.map((i) => i.task_id))
  for (const inputId of inputTaskIds) {
    if (!outputTaskIds.has(inputId)) {
      throw new Error(`[${id}] input task ${inputId} is missing from the output`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelForFeature(feature: string): string {
  switch (feature) {
    case 'enrichment':
      return process.env.OPENTASK_AI_ENRICHMENT_MODEL || 'haiku'
    case 'bubble':
      return process.env.OPENTASK_AI_BUBBLE_MODEL || 'haiku'
    case 'review':
      return process.env.OPENTASK_AI_REVIEW_MODEL || 'haiku'
    default:
      return 'haiku'
  }
}
