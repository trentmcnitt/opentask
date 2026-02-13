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

/**
 * Testing philosophy: see docs/AI.md § "Testing Philosophy"
 *
 * Key principles:
 * - No production feedback loop — quality tests ARE the quality bar
 * - Scenarios must be realistic (dictation artifacts, real-world variety)
 * - review_expectations enforce hard rules; quality_notes guide Layer 2
 * - Signal restraint: 60-70% of tasks should get zero signals
 * - Any prompt change requires full Layer 1 + Layer 2 on ALL scenarios
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
  ScenarioRequirements,
  ScenarioOutput,
  RunSummary,
} from './types'

// ---------------------------------------------------------------------------
// Skip all tests if AI is not enabled
// ---------------------------------------------------------------------------

const AI_ENABLED = process.env.OPENTASK_AI_ENABLED === 'true'
const LARGE_TESTS_ENABLED = process.env.QUALITY_TEST_LARGE === 'true'

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

  // Ensure a project exists for the tasks FK constraint (used by production code path).
  // Use id=999 to match our test user and avoid collision with real project data.
  const existingProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(999)
  if (!existingProject) {
    db.prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`).run(
      999,
      'Quality Test',
      QUALITY_TEST_USER_ID,
    )
  }

  // Clean up any leftover data from previous runs
  db.prepare('DELETE FROM ai_review_results WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM ai_review_sessions WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(QUALITY_TEST_USER_ID)

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
      const input = scenario.input as ReviewInput
      const isLarge = input.tasks.length > 100
      const skipReason = !AI_ENABLED || (isLarge && !LARGE_TESTS_ENABLED)

      test.skipIf(skipReason)(
        isLarge ? `${scenario.id} [large - ${input.tasks.length} tasks]` : scenario.id,
        async () => {
          await runScenario(scenario)
        },
        // Large scenarios get a 12 minute timeout
        isLarge ? 720_000 : undefined,
      )
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
      case 'review': {
        const reviewInput = scenario.input as ReviewInput
        if (reviewInput.useProductionCodePath) {
          ;({ output, durationMs } = await runReviewViaProduction(reviewInput))
        } else {
          ;({ output, durationMs } = await runReview(reviewInput))
        }
        break
      }
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
  const { formatMorningTime } = await import('@/lib/snooze')
  const { z } = await import('zod')

  const projectList = input.projects
    .map((p) => `- ${p.name} (id: ${p.id}${p.shared ? ', shared' : ''})`)
    .join('\n')

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  // Use scenario-provided values or sensible defaults matching production
  const morningTime = input.morningTime ?? '09:00'
  const wakeTime = input.wakeTime ?? '07:00'
  const sleepTime = input.sleepTime ?? '22:00'
  const formattedMorning = formatMorningTime(morningTime)
  const formattedWake = formatMorningTime(wakeTime)
  const formattedSleep = formatMorningTime(sleepTime)

  const prompt = `${ENRICHMENT_SYSTEM_PROMPT}

## Context

User's timezone: ${input.timezone}
Current UTC time: ${new Date().toISOString()}

User's schedule:
- Default task time: ${formattedMorning} (when no specific time is mentioned, use this)
- Wakes up: ${formattedWake}
- Goes to sleep: ${formattedSleep}

When resolving time-of-day language:
- "tomorrow" with no time specified → default task time (${formattedMorning})
- "morning" → default task time (${formattedMorning})
- "afternoon" → use your judgment, typically early afternoon
- "evening" → use your judgment, typically early evening
- "tonight" / "bedtime" / "before bed" → sleep time (${formattedSleep})

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
    // Match production: enable extended thinking for Opus models
    ...((process.env.OPENTASK_AI_BUBBLE_MODEL || 'haiku').includes('opus') && {
      maxThinkingTokens: 10000,
    }),
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
  const { formatTaskLine, sanitizeSignals } = await import('@/core/ai/review')
  const { z } = await import('zod')
  const { DateTime } = await import('luxon')

  const now = DateTime.now().setZone(input.timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  const taskLines = input.tasks.map((t) => formatTaskLine(t, input.timezone, now)).join('\n')

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${REVIEW_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total tasks: ${input.tasks.length}${userContextBlock}

## Tasks

${taskLines}

Score every task below. Return a JSON array with one entry per task.`

  const jsonSchema = z.toJSONSchema(ReviewBatchResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_REVIEW_MODEL || 'claude-opus-4-6',
    maxTurns: 1,
    // Match production: enable extended thinking for Opus models
    ...((process.env.OPENTASK_AI_REVIEW_MODEL || 'claude-opus-4-6').includes('opus') && {
      maxThinkingTokens: 10000,
    }),
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_review',
    inputText: `${input.tasks.length} tasks`,
    timeoutMs: 600_000,
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

  // Apply the same signal sanitization as production code
  const taskMap = new Map(input.tasks.map((t) => [t.id, t]))
  sanitizeSignals(parsed, taskMap)

  // Wrap the array in an object for consistent output handling
  return {
    output: { items: parsed } as unknown as Record<string, unknown>,
    durationMs: result.durationMs,
  }
}

/**
 * Run review via the production processReviewChunks code path.
 *
 * Calls startReviewGeneration + polls getReviewSessionStatus to completion,
 * then retrieves results with getReviewResults. Tests real chunking, shuffle,
 * calibration summary, and result merging.
 */
async function runReviewViaProduction(
  input: ReviewInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { startReviewGeneration, getReviewSessionStatus, getReviewResults } =
    await import('@/core/ai/review')
  const { getDb } = await import('@/core/db')

  // Insert task rows so storeReviewResults can satisfy FK constraint
  // (ai_review_results.task_id → tasks.id)
  const db = getDb()
  const insertTask = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, user_id, project_id, title, priority, created_at, labels)
     VALUES (?, ?, 999, ?, ?, ?, '[]')`,
  )
  for (const t of input.tasks) {
    insertTask.run(t.id, QUALITY_TEST_USER_ID, t.title, t.priority, t.created_at)
  }

  const startMs = Date.now()
  const { sessionId } = startReviewGeneration(
    QUALITY_TEST_USER_ID,
    input.timezone,
    input.tasks,
    input.userContext,
  )

  // Poll for completion (max 10 minutes for large lists)
  const maxWaitMs = 600_000
  const pollIntervalMs = 2_000
  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const session = getReviewSessionStatus(sessionId, QUALITY_TEST_USER_ID)
    if (!session) throw new Error('Review session not found')
    if (session.status === 'complete') break
    if (session.status === 'failed') throw new Error(`Review failed: ${session.error}`)
  }

  const { results } = getReviewResults(QUALITY_TEST_USER_ID)
  const durationMs = Date.now() - startMs

  // Clean up: remove review results and task rows created for this run
  db.prepare('DELETE FROM ai_review_results WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM ai_review_sessions WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(QUALITY_TEST_USER_ID)

  // Convert to the same { items: [...] } format as runReview
  const items = results.map((r) => ({
    task_id: r.task_id,
    score: r.score,
    commentary: r.commentary,
    signals: r.signals,
  }))

  return {
    output: { items } as unknown as Record<string, unknown>,
    durationMs,
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
      validateReviewExpectations(
        scenario.id,
        output,
        scenario.input as ReviewInput,
        scenario.requirements,
      )
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

  // Every input task should have a result.
  // For large lists (100+ tasks), allow up to 2% missing — the AI occasionally
  // drops a task from its output, and the production code path handles this
  // gracefully (missing tasks just don't get stored).
  const outputTaskIds = new Set(items.map((i) => i.task_id))
  const missingIds: number[] = []
  for (const inputId of inputTaskIds) {
    if (!outputTaskIds.has(inputId)) {
      missingIds.push(inputId)
    }
  }
  const maxMissing = input.tasks.length > 100 ? Math.ceil(input.tasks.length * 0.02) : 0
  if (missingIds.length > maxMissing) {
    throw new Error(
      `[${id}] ${missingIds.length} input tasks missing from output ` +
        `(max ${maxMissing} allowed for ${input.tasks.length} tasks): ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? '...' : ''}`,
    )
  }
}

/**
 * Validate deterministic review expectations — both always-on rules
 * and per-scenario checks from review_expectations.
 */
function validateReviewExpectations(
  id: string,
  output: Record<string, unknown>,
  input: ReviewInput,
  requirements: ScenarioRequirements,
): void {
  const items = output.items as Array<{
    task_id: number
    score: number
    signals: string[]
    commentary: string
  }>
  if (!Array.isArray(items)) return

  // Build lookup maps
  const itemMap = new Map(items.map((item) => [item.task_id, item]))
  const taskMap = new Map(input.tasks.map((t) => [t.id, t]))

  // --- Always-on checks (every review scenario) ---

  for (const item of items) {
    const task = taskMap.get(item.task_id)
    if (!task) continue
    const signals = item.signals || []

    // P4 score ceiling: P4 tasks should score low because they're already visible.
    // Allow a higher ceiling (50) when the AI flags the task as "misprioritized" —
    // generated P4 tasks with mundane content (e.g. "Renew passport" at P4)
    // are legitimately worth calling out, and the AI correctly scores them higher.
    if (task.priority === 4) {
      const hasMisprioritized = signals.includes('misprioritized')
      const ceiling = hasMisprioritized ? 50 : 25
      if (item.score > ceiling) {
        throw new Error(
          `[${id}] P4 task ${item.task_id} ("${task.title}") scored ${item.score}, ` +
            `expected 0-${ceiling} (P4 tasks are already visible${hasMisprioritized ? ', misprioritized allows higher' : ''})`,
        )
      }
      // P4 no signals (except misprioritized — the whole point is the priority is wrong)
      const nonMisprioritizedSignals = signals.filter((s) => s !== 'misprioritized')
      if (nonMisprioritizedSignals.length > 0) {
        throw new Error(
          `[${id}] P4 task ${item.task_id} ("${task.title}") has signals ` +
            `[${nonMisprioritizedSignals.join(', ')}], expected none (except misprioritized)`,
        )
      }
    }

    // Stale age floor: stale signal requires task to be 21+ days old
    if (signals.includes('stale') && task.created_at) {
      const createdMs = new Date(task.created_at).getTime()
      const age = Math.floor((Date.now() - createdMs) / (1000 * 60 * 60 * 24))
      if (age < 21) {
        throw new Error(
          `[${id}] task ${item.task_id} ("${task.title}") has "stale" signal but is only ` +
            `${age} days old (minimum 21 days)`,
        )
      }
    }

    // act_soon priority gate: act_soon requires P3+
    if (signals.includes('act_soon') && task.priority < 3) {
      throw new Error(
        `[${id}] task ${item.task_id} ("${task.title}") has "act_soon" signal but is P${task.priority} ` +
          `(act_soon requires P3+)`,
      )
    }
  }

  // Score spread: for 10+ tasks, std dev must be > 10
  // Skip this check for scenarios with min_zero_signal_pct >= 60 — those are
  // intentionally homogeneous (all routine tasks) where low variance is expected.
  const isHomogeneous =
    requirements.review_expectations?.min_zero_signal_pct != null &&
    requirements.review_expectations.min_zero_signal_pct >= 60
  if (items.length >= 10 && !isHomogeneous) {
    const scores = items.map((i) => i.score)
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length
    const stdDev = Math.sqrt(variance)
    if (stdDev <= 10) {
      throw new Error(
        `[${id}] score std dev is ${stdDev.toFixed(1)} for ${items.length} tasks ` +
          `(expected > 10 — scores should be spread out, not clustered)`,
      )
    }
  }

  // --- Per-scenario checks (when review_expectations is set) ---

  const expectations = requirements.review_expectations
  if (!expectations) return

  // Score ranges
  if (expectations.score_ranges) {
    for (const [taskIdStr, range] of Object.entries(expectations.score_ranges)) {
      const taskId = Number(taskIdStr)
      const item = itemMap.get(taskId)
      if (!item) {
        throw new Error(`[${id}] expected score for task ${taskId} but it wasn't in output`)
      }
      if (item.score < range.min || item.score > range.max) {
        const task = taskMap.get(taskId)
        throw new Error(
          `[${id}] task ${taskId} ("${task?.title}") scored ${item.score}, ` +
            `expected ${range.min}-${range.max}`,
        )
      }
    }
  }

  // Signal checks
  if (expectations.signal_checks) {
    for (const [taskIdStr, checks] of Object.entries(expectations.signal_checks)) {
      const taskId = Number(taskIdStr)
      const item = itemMap.get(taskId)
      if (!item) {
        throw new Error(`[${id}] expected signal check for task ${taskId} but it wasn't in output`)
      }
      const signals = item.signals || []

      if (checks.must_have) {
        for (const required of checks.must_have) {
          if (!signals.includes(required)) {
            const task = taskMap.get(taskId)
            throw new Error(
              `[${id}] task ${taskId} ("${task?.title}") missing required signal ` +
                `"${required}" (has: [${signals.join(', ')}])`,
            )
          }
        }
      }

      if (checks.must_not_have) {
        for (const forbidden of checks.must_not_have) {
          if (signals.includes(forbidden)) {
            const task = taskMap.get(taskId)
            throw new Error(
              `[${id}] task ${taskId} ("${task?.title}") has forbidden signal ` +
                `"${forbidden}" (has: [${signals.join(', ')}])`,
            )
          }
        }
      }
    }
  }

  // Minimum zero-signal percentage
  if (expectations.min_zero_signal_pct != null) {
    const zeroSignalCount = items.filter((i) => !i.signals || i.signals.length === 0).length
    const pct = (zeroSignalCount / items.length) * 100
    if (pct < expectations.min_zero_signal_pct) {
      throw new Error(
        `[${id}] only ${pct.toFixed(0)}% of tasks have zero signals ` +
          `(expected >= ${expectations.min_zero_signal_pct}%)`,
      )
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
      return process.env.OPENTASK_AI_REVIEW_MODEL || 'claude-opus-4-6'
    default:
      return 'haiku'
  }
}
