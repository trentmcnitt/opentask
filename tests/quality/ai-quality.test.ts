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
 * - insights_expectations enforce hard rules; quality_notes guide Layer 2
 * - Signal restraint: 60-70% of tasks should get zero signals
 * - Any prompt change requires full Layer 1 + Layer 2 on ALL scenarios
 */

import { describe, test, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { DateTime } from 'luxon'
import { allScenarios } from './scenarios/index'
import { requireFeatureModel, resolveSDKModel } from '@/core/ai/models'
import type { AIFeature } from '@/core/ai/models'
import type {
  AITestScenario,
  EnrichmentInput,
  ReminderEnrichmentInput,
  QuotaEnrichmentInput,
  WhatsNextInput,
  InsightsInput,
  QuickTakeInput,
  ProcessProjectsInput,
  ProcessDuplicatesInput,
  ScenarioRequirements,
  ScenarioOutput,
  RunSummary,
} from './types'

// ---------------------------------------------------------------------------
// Skip all tests if AI is not enabled
// ---------------------------------------------------------------------------

const AI_ENABLED = process.env.OPENTASK_AI_ENABLED === 'true'
const LARGE_TESTS_ENABLED = process.env.QUALITY_TEST_LARGE === 'true'
// SHELVED (2026-10-22; src/core/ai/shelved.ts): What's Next, Insights and
// Quick Take are shelved, so their scenarios are skipped by default — kept,
// not deleted. Include them with the server's own switch:
//   OPENTASK_AI_ENABLED=true OPENTASK_AI_UNSHELVE=1 npm run test:quality
const SHELVED_RUN = process.env.OPENTASK_AI_UNSHELVE === '1'

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
  db.prepare('DELETE FROM ai_insights_results WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM ai_insights_sessions WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
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
    model: getModelForFeature('enrichment'),
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

  Feature:   all (enrichment, whats_next, insights, quick_take)
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
  // Reminder enrichment scenarios (REDESIGN-V03 §6)
  // -------------------------------------------------------------------------

  describe('Reminder enrichment', () => {
    const reminderTests = allScenarios.filter((s) => s.feature === 'enrichment_reminder')

    for (const scenario of reminderTests) {
      test.skipIf(!AI_ENABLED)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Quota enrichment scenarios (2026-10-24)
  // -------------------------------------------------------------------------

  describe('Quota enrichment', () => {
    const quotaTests = allScenarios.filter((s) => s.feature === 'enrichment_quota')

    for (const scenario of quotaTests) {
      test.skipIf(!AI_ENABLED)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // What's Next scenarios
  // -------------------------------------------------------------------------

  describe("What's Next", () => {
    const whatsNextTests = allScenarios.filter((s) => s.feature === 'whats_next')

    for (const scenario of whatsNextTests) {
      test.skipIf(!AI_ENABLED || !SHELVED_RUN)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Quick Take scenarios
  // -------------------------------------------------------------------------

  describe('Quick Take', () => {
    const quickTakeTests = allScenarios.filter((s) => s.feature === 'quick_take')

    for (const scenario of quickTakeTests) {
      test.skipIf(!AI_ENABLED || !SHELVED_RUN)(scenario.id, async () => {
        await runScenario(scenario)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Process scenarios (2026-10-10)
  // -------------------------------------------------------------------------

  describe('Process', () => {
    const processTests = allScenarios.filter(
      (s) => s.feature === 'process_projects' || s.feature === 'process_duplicates',
    )

    for (const scenario of processTests) {
      test.skipIf(!AI_ENABLED)(
        scenario.id,
        async () => {
          await runScenario(scenario)
        },
        300_000,
      )
    }
  })

  // -------------------------------------------------------------------------
  // Insights scenarios
  // -------------------------------------------------------------------------

  describe('Insights', () => {
    const insightsTests = allScenarios.filter((s) => s.feature === 'insights')

    for (const scenario of insightsTests) {
      const input = scenario.input as InsightsInput
      const isLarge = input.tasks.length > 100
      const skipReason = !AI_ENABLED || !SHELVED_RUN || (isLarge && !LARGE_TESTS_ENABLED)

      test.skipIf(skipReason)(
        isLarge ? `${scenario.id} [large - ${input.tasks.length} tasks]` : scenario.id,
        async () => {
          await runScenario(scenario)
        },
        // Timeout scales with task count: 12min for large, 10s/task for others, 3min minimum
        isLarge ? 720_000 : Math.max(180_000, input.tasks.length * 10_000),
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
    // The moment an enrichment scenario was run at (its pinned `now`, or the
    // clock): the time matchers and the Layer 2 judge read it.
    let runNow: Date | undefined

    switch (scenario.feature) {
      case 'enrichment':
        ;({
          output,
          durationMs,
          now: runNow,
        } = await runEnrichment(scenario.input as EnrichmentInput))
        break
      case 'enrichment_reminder':
        ;({ output, durationMs } = await runReminderEnrichment(
          scenario.input as ReminderEnrichmentInput,
        ))
        break
      case 'enrichment_quota':
        ;({ output, durationMs } = await runQuotaEnrichment(scenario.input as QuotaEnrichmentInput))
        break
      case 'whats_next':
        ;({ output, durationMs } = await runWhatsNext(scenario.input as WhatsNextInput))
        break
      case 'insights': {
        const insightsInput = scenario.input as InsightsInput
        if (insightsInput.useProductionCodePath) {
          ;({ output, durationMs } = await runInsightsViaProduction(insightsInput))
        } else {
          ;({ output, durationMs } = await runInsights(insightsInput))
        }
        break
      }
      case 'quick_take':
        ;({ output, durationMs } = await runQuickTake(scenario.input as QuickTakeInput))
        break
      case 'process_projects':
        ;({ output, durationMs } = await runProcessProjects(scenario.input as ProcessProjectsInput))
        break
      case 'process_duplicates':
        ;({ output, durationMs } = await runProcessDuplicates(
          scenario.input as ProcessDuplicatesInput,
        ))
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
          ...(runNow && {
            run_now_local: DateTime.fromJSDate(runNow)
              .setZone((scenario.input as EnrichmentInput).timezone)
              .toFormat('ccc, LLL d, yyyy, h:mm a'),
          }),
        },
        null,
        2,
      ),
    )

    // Structural assertions
    validateStructure(scenario, output, runNow)

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

/**
 * The scenario's "now": its pinned local `now`, or the moment it runs. One
 * instant for the prompt, every post-process and the matchers, so a scenario
 * at a quarter-hour boundary is judged against the minute the model was shown.
 */
function scenarioNow(input: EnrichmentInput): Date {
  if (!input.now) return new Date()
  return DateTime.fromISO(input.now, { zone: input.timezone }).toJSDate()
}

async function runEnrichment(
  input: EnrichmentInput,
): Promise<{ output: Record<string, unknown>; durationMs: number; now: Date }> {
  const { ENRICHMENT_SYSTEM_PROMPT, buildEnrichmentUserPrompt } = await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { EnrichmentResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')
  const { DEFAULT_DAY_START } = await import('@/lib/anchor-times')

  const now = scenarioNow(input)
  // The user's periods (2026-10-24): listed in the prompt for a relative
  // target's period, and mapped against the same rows — as production does.
  const { DEFAULT_TIME_SLOTS } = await import('@/lib/time-slot-assign')
  const periods = input.slots ?? [...DEFAULT_TIME_SLOTS]
  const morningTime = input.morningTime ?? '09:00'
  const prompt = buildEnrichmentUserPrompt({
    timezone: input.timezone,
    morningTime,
    wakeTime: input.wakeTime ?? '07:00',
    sleepTime: input.sleepTime ?? '22:00',
    periods,
    projects: input.projects,
    userContext: input.userContext,
    taskText: input.text,
    now,
    // A default user's day (3:00 AM, the task queue on), like the post-process.
    dayStart: DEFAULT_DAY_START,
  })

  const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)

  const provider = getTestProvider()
  // SDK mode needs extra turns for structured output (the CLI uses one turn
  // for generation and one for schema validation). API mode handles it in one call.
  const maxTurns = provider === 'sdk' ? 3 : 1
  const result = await aiQuery({
    prompt,
    systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
    outputSchema: jsonSchema,
    model: getModelForFeature('enrichment'),
    maxTurns,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_enrich',
    inputText: input.text,
    provider,
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

  // Production runs the project through filterProjectMatch before storing it,
  // so the scenario is judged on what the database would receive. When the
  // guard changes the model's answer, the raw value is logged so a prompt
  // regression the guard is hiding still shows up in the run output.
  const { filterProjectMatch, postProcessTaskEnrichment } = await import('@/core/ai/enrichment')
  const { targetTodayTime } = await import('@/core/tasks/task-segments')
  const guarded = filterProjectMatch(parsed.project_name ?? null, input.text)
  if (guarded !== (parsed.project_name ?? null)) {
    console.log(
      `[quality] project guard nulled model project_name "${parsed.project_name}" for: ${input.text}`,
    )
  }

  // Same for the task model's deadline/horizon guard (2026-10-10): judged on
  // what production stores, with the raw answer logged when the guard changed it.
  // A date-only target ("today", no time) is placed the way production places it.
  // A repeat with no day named is pinned to today (`pinUnnamedDay`, 2026-10-12);
  // a yearly rule in a named month with no day, to the 1st (2026-10-13).
  // "now" / "in an hour" are counted in code (`resolveSoonTarget`, 2026-10-16).
  // Unstated past dates are dropped (`dropUnstatedPastDates`, 2026-10-16).
  // One shared function: the same one production calls.
  const taskModel = postProcessTaskEnrichment(parsed, input.text, input.timezone, {
    morningTime,
    // At the scenario's own now, so a pinned 10:57 PM places "today" as production would then.
    todayTarget: targetTodayTime(QUALITY_TEST_USER_ID, input.timezone, now),
    // On deck (D3): A4's "tomorrow" before the rollover — a default user's
    // (the fixed "Day starts at" default, 3:00 AM since 2026-10-24), fixed so
    // a scenario never depends on the quality DB's user's settings. The
    // check-in day is the default Saturday (`checkInDay` left out), as for a
    // default user.
    rolloverTime: DEFAULT_DAY_START,
    dayStart: DEFAULT_DAY_START,
    now,
    // Every scenario is a new task's first enrichment, as in production.
    newTask: true,
    // A relative target's time and period (2026-10-24): the scenario's
    // periods as rows (ids 1..n, as the reminder runner builds them), and the
    // Default task time custom — what production passes for such a user.
    relative: {
      slots: slotRows(periods),
      defaultTime: { time: morningTime, slot_id: null },
    },
  })
  if (taskModel.rrule !== parsed.rrule) {
    console.log(
      `[quality] day pin changed rrule "${parsed.rrule}" → "${taskModel.rrule}" for: ${input.text}`,
    )
  }
  if (
    taskModel.deadline_at !== parsed.deadline_at ||
    taskModel.horizon !== parsed.horizon ||
    taskModel.due_at !== parsed.due_at
  ) {
    console.log(
      `[quality] task-model guard changed due_at "${parsed.due_at}" / deadline_at "${parsed.deadline_at}" / horizon "${parsed.horizon}" for: ${input.text}`,
    )
  }
  // A repeat phrase the rule already says is stripped from the title
  // (`stripRepeatPhrase`, 2026-10-16) — logged so a prompt miss stays visible.
  if (taskModel.title !== parsed.title) {
    console.log(`[quality] title strip changed "${parsed.title}" → "${taskModel.title}"`)
  }

  logDeckFloor(parsed, taskModel, input.text)
  logRelativeTarget(parsed, taskModel, input.text)

  // The period a relative target follows, by name — for the Layer 2 judge.
  const linked = periods[(taskModel.target_slot_id ?? 0) - 1]
  return {
    // `on_deck_day` and the relative target always present (null when unset),
    // so scenarios can require them.
    output: {
      on_deck_day: null,
      target_days_before: null,
      target_time: null,
      target_period: null,
      target_slot_id: null,
      ...taskModel,
      target_slot_label: linked?.label ?? null,
      project_name: guarded,
    } as unknown as Record<string, unknown>,
    durationMs: result.durationMs,
    now,
  }
}

/** A scenario's periods as `TimeSlot` rows, ids 1..n in order. */
function slotRows(slots: Array<{ label: string; start_time: string }>) {
  return slots.map((slot, index) => ({
    id: index + 1,
    user_id: QUALITY_TEST_USER_ID,
    label: slot.label,
    start_time: slot.start_time,
    sort_order: index,
    created_at: new Date().toISOString(),
  }))
}

/**
 * Relative targets (2026-10-24): logged when the floor (`sanitizeTaskModelFields`
 * / `resolveEnrichmentRelative`) dropped the model's offsets, or the mapping
 * chose a time the model did not write — so a prompt miss stays visible.
 */
function logRelativeTarget(
  parsed: { target_days_before?: number | null; target_time?: string | null },
  taskModel: { target_days_before?: number | null; target_time?: string | null },
  text: string,
): void {
  if (parsed.target_days_before == null) return
  if (taskModel.target_days_before == null) {
    console.log(`[quality] relative floor dropped ${parsed.target_days_before} day(s) for: ${text}`)
  } else if (parsed.target_time !== taskModel.target_time) {
    console.log(
      `[quality] relative time "${parsed.target_time}" → "${taskModel.target_time}" for: ${text}`,
    )
  }
}

/**
 * On deck (D3): a day with no time is written as `on_deck_day` (the model's
 * bare date, settled by `resolveDeckDay`). Logged when the model wrote a TIME
 * the code floor turned into a day, so a prompt miss the floor hides still
 * shows in the run output.
 */
function logDeckFloor(
  parsed: { due_at: string | null },
  taskModel: { on_deck_day?: string | null },
  text: string,
): void {
  if (!taskModel.on_deck_day || /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_at ?? '')) return
  console.log(
    `[quality] deck floor: model due_at "${parsed.due_at}" → on deck ${taskModel.on_deck_day} for: ${text}`,
  )
}

/**
 * Reminder enrichment (REDESIGN-V03 §6) — the same production builder and
 * schema as a task, but the reminder user prompt and the sanitizer that runs
 * on its result in production, so what a scenario is judged on is what the
 * database would actually receive.
 */
async function runReminderEnrichment(
  input: ReminderEnrichmentInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { ENRICHMENT_SYSTEM_PROMPT, buildReminderEnrichmentUserPrompt } =
    await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { EnrichmentResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { sanitizeReminderEnrichment, pinUnnamedDay } = await import('@/core/ai/enrichment')
  const { DEFAULT_TIME_SLOTS } = await import('@/lib/time-slot-assign')
  const { DEFAULT_DAY_START } = await import('@/lib/anchor-times')
  const { z } = await import('zod')

  const slots = input.slots ?? [...DEFAULT_TIME_SLOTS]
  const prompt = buildReminderEnrichmentUserPrompt({
    timezone: input.timezone,
    slots,
    defaultSlotLabel: input.defaultSlotLabel ?? null,
    userContext: input.userContext,
    taskText: input.text,
  })

  const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)
  const provider = getTestProvider()
  const maxTurns = provider === 'sdk' ? 3 : 1
  const result = await aiQuery({
    prompt,
    systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
    outputSchema: jsonSchema,
    model: getModelForFeature('enrichment'),
    maxTurns,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_enrich_reminder',
    inputText: input.text,
    provider,
  })

  const parsed = parseAIResponse(result, EnrichmentResultSchema, 'Enrichment', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const attempt = EnrichmentResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`AI query failed: ${result.error || 'No output'}`)
  }

  // Production order: the day pin (`pinUnnamedDay`), then the reminder sanitizer.
  const sanitized = sanitizeReminderEnrichment(
    pinUnnamedDay(parsed, input.text, input.timezone, new Date(), DEFAULT_DAY_START),
    slotRows(slots),
    input.defaultSlotLabel ?? null,
  )

  return { output: sanitized as unknown as Record<string, unknown>, durationMs: result.durationMs }
}

/**
 * Quota enrichment (2026-10-24) — the same production builder and schema as a
 * task, but the quota user prompt and the ONE post-process production runs on
 * its answer (`postProcessQuotaEnrichment`), so only the model call is
 * duplicated here. The output is that plan in stored shapes (`rrule`,
 * `progress_target`, the prompt period's label), so `must_include` asserts what
 * the database would receive.
 */
async function runQuotaEnrichment(
  input: QuotaEnrichmentInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { ENRICHMENT_SYSTEM_PROMPT, buildQuotaEnrichmentUserPrompt } =
    await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { EnrichmentResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { postProcessQuotaEnrichment } = await import('@/core/ai/quota-enrichment')
  const { DEFAULT_TIME_SLOTS } = await import('@/lib/time-slot-assign')
  const { z } = await import('zod')

  const slots = input.slots ?? [...DEFAULT_TIME_SLOTS]
  const prompt = buildQuotaEnrichmentUserPrompt({
    timezone: input.timezone,
    slots,
    userContext: input.userContext,
    taskText: input.text,
  })

  const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)
  const provider = getTestProvider()
  const maxTurns = provider === 'sdk' ? 3 : 1
  const result = await aiQuery({
    prompt,
    systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
    outputSchema: jsonSchema,
    model: getModelForFeature('enrichment'),
    maxTurns,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_enrich_quota',
    inputText: input.text,
    provider,
  })

  const parsed = parseAIResponse(result, EnrichmentResultSchema, 'Enrichment', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const attempt = EnrichmentResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`AI query failed: ${result.error || 'No output'}`)
  }

  // The model's own period fields, logged when the post-process had to fall
  // back on a task-style rule — so a prompt miss the fallback hides still shows.
  if (parsed.rrule) {
    console.log(`[quality] quota answer carried a task rule "${parsed.rrule}" for: ${input.text}`)
  }

  const plan = postProcessQuotaEnrichment(
    parsed,
    input.text,
    slots.map((slot, index) => ({ id: index + 1, label: slot.label, start_time: slot.start_time })),
  )

  return {
    output: {
      title: plan.title,
      notes: plan.notes,
      priority: plan.priority,
      labels: plan.labels,
      rrule: plan.rrule,
      progress_target: plan.progress_target,
      prompt_slot_label: plan.prompt_slot_label,
      prompt_enabled: plan.prompt_enabled,
      // The raw answer, for the Layer 2 judge (never asserted on).
      model_answer: parsed,
    },
    durationMs: result.durationMs,
  }
}

async function runWhatsNext(
  input: WhatsNextInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { WHATS_NEXT_SYSTEM_PROMPT, WHATS_NEXT_REMINDERS } = await import('@/core/ai/prompts')
  const { formatTaskLine } = await import('@/core/ai/format')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { WhatsNextResultSchema } = await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')

  const { DateTime } = await import('luxon')
  const now = DateTime.now().setZone(input.timezone)

  // Match production (buildTaskSummaries): a deadline-only task shows its implied target.
  const { withEffectiveSummaryTarget } = await import('@/core/ai/task-summaries')
  const ctx = { timezone: input.timezone, morningTime: '09:00' }
  const taskList = input.tasks
    .map((t) => formatTaskLine(withEffectiveSummaryTarget(t, ctx), input.timezone, now))
    .join('\n')

  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${WHATS_NEXT_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total active tasks: ${input.tasks.length}${userContextBlock}
<tasks>
${taskList}
</tasks>

${WHATS_NEXT_REMINDERS}
Current time: ${currentTime}
Surface 3-7 tasks and return the JSON result.`

  const jsonSchema = z.toJSONSchema(WhatsNextResultSchema)

  const whatsNextProvider = getTestProvider()
  const maxTurns = whatsNextProvider === 'sdk' ? 3 : 1
  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: getModelForFeature('whats_next'),
    maxTurns,
    // Match production: enable extended thinking for Opus models
    ...(getModelForFeature('whats_next').includes('opus') && {
      maxThinkingTokens: 10000,
    }),
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_whats_next',
    inputText: `${input.tasks.length} tasks`,
    provider: whatsNextProvider,
  })

  // Use the same parsing + normalization as production whats-next.ts
  const parsed = parseAIResponse(result, WhatsNextResultSchema, "What's Next", (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    if ('tasks_to_surface' in json && !('tasks' in json)) {
      json.tasks = json.tasks_to_surface
      delete json.tasks_to_surface
    }
    if (!json.generated_at) {
      json.generated_at = new Date().toISOString()
    }
    const attempt = WhatsNextResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`What's Next query failed: ${result.error || 'Could not parse output'}`)
  }

  return { output: parsed as unknown as Record<string, unknown>, durationMs: result.durationMs }
}

async function runQuickTake(
  input: QuickTakeInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { buildQuickTakePrompt, formatCompactTaskList, buildTaskStats } =
    await import('@/core/ai/quick-take')
  const { aiQuery } = await import('@/core/ai/sdk')

  // Build the compact task list from scenario data (same format as production)
  const tasksForPrompt = input.tasks.map((t) => ({
    title: t.title,
    project_name: t.project_name ?? null,
    due_at: t.due_at,
    deadline_at: t.deadline_at ?? null,
    on_deck_day: t.on_deck_day ?? null,
    priority: t.priority,
    labels: t.labels,
    rrule: t.rrule ?? null,
  }))
  const { text: compactTaskList, count } = formatCompactTaskList(tasksForPrompt, input.timezone)
  const stats = buildTaskStats(tasksForPrompt, input.timezone)

  // Build the prompt using the same production function
  // Quick take scenarios always test tasks with no due date (pre-enrichment)
  const prompt = buildQuickTakePrompt(
    compactTaskList,
    count,
    input.timezone,
    input.newTaskTitle,
    stats,
    false,
    tasksForPrompt,
  )

  const model = getModelForFeature('quick_take')
  const quickTakeProvider = getTestProvider()
  // Quick Take returns plain text (no outputSchema), so maxTurns: 1 works
  // for both SDK and API mode — no schema validation turn needed.
  const result = await aiQuery({
    prompt,
    model,
    maxTurns: 1,
    timeoutMs: 30_000,
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_quick_take',
    inputText: input.newTaskTitle,
    provider: quickTakeProvider,
  })

  if (!result.success || !result.textResult) {
    throw new Error(`Quick Take query failed: ${result.error || 'No text result'}`)
  }

  // Strip surrounding quotes (same as production)
  let text = result.textResult.trim()
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim()
  }

  return {
    output: { text } as unknown as Record<string, unknown>,
    durationMs: result.durationMs,
  }
}

async function runInsights(
  input: InsightsInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { INSIGHTS_SYSTEM_PROMPT, INSIGHTS_REMINDERS } = await import('@/core/ai/prompts')
  const { aiQuery } = await import('@/core/ai/sdk')
  const { InsightsBatchResultSchema, InsightsBatchEnvelopeSchema, InsightsBatchResponseSchema } =
    await import('@/core/ai/types')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { formatTaskLine } = await import('@/core/ai/format')
  const { sanitizeSignals } = await import('@/core/ai/insights')
  const { z } = await import('zod')
  const { DateTime } = await import('luxon')

  const now = DateTime.now().setZone(input.timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  // Match production (buildTaskSummaries): a deadline-only task shows its implied target.
  const { withEffectiveSummaryTarget } = await import('@/core/ai/task-summaries')
  const ctx = { timezone: input.timezone, morningTime: '09:00' }

  // A list production would split (more tasks than one call's output budget
  // holds for this provider and model) runs through the production chunking
  // path, so the test sees the calls production makes. Smaller lists are one
  // call either way and stay on this direct path.
  const { insightsTasksPerCall } = await import('@/core/ai/insights')
  if (input.tasks.length > insightsTasksPerCall(await insightsTestConfig())) {
    return runInsightsViaProduction({
      ...input,
      tasks: input.tasks.map((t) => withEffectiveSummaryTarget(t, ctx)),
    })
  }
  const taskLines = input.tasks
    .map((t) => formatTaskLine(withEffectiveSummaryTarget(t, ctx), input.timezone, now))
    .join('\n')

  const userContextBlock = input.userContext ? `\nUser context: ${input.userContext}\n` : ''

  const prompt = `${INSIGHTS_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total tasks: ${input.tasks.length}${userContextBlock}
<tasks>
${taskLines}
</tasks>

${INSIGHTS_REMINDERS}
Current time: ${currentTime}
Score every task above. Return one entry per task in "tasks".`

  // Must match production: the schema root has to be an object, so the array
  // travels wrapped. See InsightsBatchEnvelopeSchema.
  const jsonSchema = z.toJSONSchema(InsightsBatchEnvelopeSchema)

  const insightsProvider = getTestProvider()
  const maxTurns = insightsProvider === 'sdk' ? 3 : 1
  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: getModelForFeature('insights'),
    maxTurns,
    // Match production: enable extended thinking for Opus models
    ...(getModelForFeature('insights').includes('opus') && {
      maxThinkingTokens: 10000,
    }),
    userId: QUALITY_TEST_USER_ID,
    action: 'quality_test_insights',
    inputText: `${input.tasks.length} tasks`,
    timeoutMs: 600_000,
    provider: insightsProvider,
  })

  const parsed = parseAIResponse(result, InsightsBatchResponseSchema, 'Insights', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const arr = Array.isArray(json) ? json : json.tasks
    if (!Array.isArray(arr)) return null
    const attempt = InsightsBatchResultSchema.safeParse(arr)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    throw new Error(`Insights query failed: ${result.error || 'Could not parse output'}`)
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
 * Process (2026-10-10) — the production prompt builders, schemas and
 * sanitizers from src/core/ai/process.ts; only the DB lookups are replaced by
 * the scenario's own projects and tasks. Model: the Process feature's, as in
 * production (OPENTASK_AI_PROCESS_MODEL, falling back to the Insights one).
 */
async function runProcessQuery<T>(
  prompt: string,
  schema: import('zod').ZodType<T>,
  action: string,
  inputText: string,
): Promise<{ parsed: T; durationMs: number }> {
  const { aiQuery } = await import('@/core/ai/sdk')
  const { parseAIResponse, extractJsonFromText } = await import('@/core/ai/parse-helpers')
  const { z } = await import('zod')

  const provider = getTestProvider()
  const result = await aiQuery({
    prompt,
    outputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    model: getModelForFeature('process'),
    maxTurns: provider === 'sdk' ? 3 : 1,
    userId: QUALITY_TEST_USER_ID,
    action,
    inputText,
    timeoutMs: 280_000,
    provider,
  })
  const parsed = parseAIResponse(result, schema, action, (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    const attempt = schema.safeParse(json)
    return attempt.success ? attempt.data : null
  })
  if (!parsed) throw new Error(`${action} failed: ${result.error || 'Could not parse output'}`)
  return { parsed, durationMs: result.durationMs }
}

async function runProcessProjects(
  input: ProcessProjectsInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { buildRecommendProjectsPrompt, ProjectRecommendationsSchema, sanitizeRecommendations } =
    await import('@/core/ai/process')
  const { parsed, durationMs } = await runProcessQuery(
    buildRecommendProjectsPrompt(input),
    ProjectRecommendationsSchema,
    'quality_test_process_projects',
    `${input.tasks.length} tasks`,
  )
  const recommendations = sanitizeRecommendations(
    parsed.recommendations,
    input.tasks.map((t) => t.id),
    new Set(input.projects.map((p) => p.id)),
  )
  if (recommendations.length !== parsed.recommendations.length) {
    console.log(
      `[quality] process sanitizer dropped ${parsed.recommendations.length - recommendations.length} recommendation(s)`,
    )
  }
  return { output: { recommendations }, durationMs }
}

async function runProcessDuplicates(
  input: ProcessDuplicatesInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { buildDuplicatesPrompt, DuplicateGroupsSchema, sanitizeDuplicateGroups } =
    await import('@/core/ai/process')
  const { parsed, durationMs } = await runProcessQuery(
    buildDuplicatesPrompt(input),
    DuplicateGroupsSchema,
    'quality_test_process_duplicates',
    `${input.tasks.length} tasks`,
  )
  const groups = sanitizeDuplicateGroups(parsed.groups, new Set(input.tasks.map((t) => t.id)))
  return { output: { groups }, durationMs }
}

/** The Insights config production would pass for the test run's provider and model. */
async function insightsTestConfig(): Promise<import('@/core/ai/models').FeatureAIConfig> {
  const { resolveFeatureAIConfig } = await import('@/core/ai/models')
  return getTestProvider() === 'sdk'
    ? { provider: 'sdk', model: getModelForFeature('insights') }
    : resolveFeatureAIConfig('insights', 'api')
}

/**
 * Run insights via the production processInsightsChunks code path.
 *
 * Calls startInsightsGeneration + polls getInsightsSessionStatus to completion,
 * then retrieves results with getInsightsResults. Tests real chunking, shuffle,
 * calibration summary, and result merging.
 */
async function runInsightsViaProduction(
  input: InsightsInput,
): Promise<{ output: Record<string, unknown>; durationMs: number }> {
  const { startInsightsGeneration, getInsightsSessionStatus, getInsightsResults } =
    await import('@/core/ai/insights')
  const { getDb } = await import('@/core/db')

  // Insert task rows so storeInsightsResults can satisfy FK constraint
  // (ai_insights_results.task_id → tasks.id)
  const db = getDb()
  const insertTask = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, user_id, project_id, title, priority, created_at, labels)
     VALUES (?, ?, 999, ?, ?, ?, '[]')`,
  )
  for (const t of input.tasks) {
    insertTask.run(t.id, QUALITY_TEST_USER_ID, t.title, t.priority, t.created_at)
  }

  // The test run's provider and model, as production passes the user's
  // resolved config — without it the run falls back to the API config and
  // would plan its chunks for the wrong output cap (or fail in SDK mode).
  const aiConfig = await insightsTestConfig()

  const startMs = Date.now()
  const { sessionId } = startInsightsGeneration(
    QUALITY_TEST_USER_ID,
    input.timezone,
    input.tasks,
    input.userContext,
    'on-demand',
    aiConfig,
  )

  // Poll for completion (max 10 minutes for large lists)
  const maxWaitMs = 600_000
  const pollIntervalMs = 2_000
  const deadline = Date.now() + maxWaitMs

  let finished = false
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const session = getInsightsSessionStatus(sessionId, QUALITY_TEST_USER_ID)
    if (!session) throw new Error('Insights session not found')
    if (session.status === 'failed') throw new Error(`Insights failed: ${session.error}`)
    // A complete session with an error scored only some tasks — a structural failure here
    if (session.status === 'complete' && session.error) {
      throw new Error(`Insights incomplete: ${session.error}`)
    }
    if (session.status === 'complete') {
      finished = true
      break
    }
  }
  // Without this, a run still going at the deadline was scored on whatever had been stored
  if (!finished) throw new Error(`Insights still running after ${maxWaitMs / 1000}s`)

  const { results } = getInsightsResults(QUALITY_TEST_USER_ID)
  const durationMs = Date.now() - startMs

  // Clean up: remove insights results and task rows created for this run
  db.prepare('DELETE FROM ai_insights_results WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM ai_insights_sessions WHERE user_id = ?').run(QUALITY_TEST_USER_ID)
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(QUALITY_TEST_USER_ID)

  // Convert to the same { items: [...] } format as runInsights
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

/** The scenario's now and timezone, for the time matchers (enrichment only). */
function clockFor(
  scenario: AITestScenario,
  runNow: Date | undefined,
): { now: Date; timezone: string } | undefined {
  const zone = (scenario.input as { timezone?: string }).timezone
  return runNow && zone ? { now: runNow, timezone: zone } : undefined
}

function validateStructure(
  scenario: AITestScenario,
  output: Record<string, unknown>,
  runNow?: Date,
): void {
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
      } else if (typeof expectedValue === 'string' && expectedValue.startsWith('~')) {
        checkSpecialExpectation(
          scenario.id,
          key,
          expectedValue,
          actualValue,
          clockFor(scenario, runNow),
        )
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

  validateFeatureSchema(scenario, output)
}

/** Feature-specific schema validation. */
/**
 * A quota plan is stored as it is: a non-empty title, a canonical period rule
 * (`FREQ=X[;INTERVAL=N]`) or null, a target of 1..1000 or null, at most one label.
 */
function validateQuotaSchema(id: string, output: Record<string, unknown>): void {
  if (typeof output.title !== 'string' || output.title.trim() === '') {
    throw new Error(`[${id}] quota title must be a non-empty string`)
  }
  const rrule = output.rrule
  if (
    rrule !== null &&
    !(
      typeof rrule === 'string' &&
      /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d+)?$/.test(rrule)
    )
  ) {
    throw new Error(`[${id}] quota rrule must be a bare period rule, got ${JSON.stringify(rrule)}`)
  }
  const target = output.progress_target
  if (target !== null && !(typeof target === 'number' && target >= 1 && target <= 1000)) {
    throw new Error(`[${id}] quota progress_target out of range: ${JSON.stringify(target)}`)
  }
  if (!Array.isArray(output.labels) || output.labels.length > 1) {
    throw new Error(`[${id}] a quota has at most one label, got ${JSON.stringify(output.labels)}`)
  }
}

function validateFeatureSchema(scenario: AITestScenario, output: Record<string, unknown>): void {
  switch (scenario.feature) {
    case 'enrichment':
      validateEnrichmentSchema(scenario.id, output)
      break
    case 'enrichment_quota':
      validateQuotaSchema(scenario.id, output)
      break
    case 'whats_next':
      validateWhatsNextSchema(scenario.id, output)
      break
    case 'insights':
      validateInsightsSchema(scenario.id, output, scenario.input as InsightsInput)
      validateInsightsExpectations(
        scenario.id,
        output,
        scenario.input as InsightsInput,
        scenario.requirements,
      )
      break
    case 'quick_take':
      validateQuickTakeSchema(scenario.id, output)
      break
    case 'process_projects':
    case 'process_duplicates':
      validateProcessExpectations(scenario.id, output, scenario.requirements)
      break
  }
}

function actSoonAllowedHere(task: { priority: number; deadline_at?: string | null }): boolean {
  if (task.deadline_at) {
    return (Date.parse(task.deadline_at) - Date.now()) / 86_400_000 <= 7
  }
  return task.priority >= 3
}

/** Process (2026-10-10): shape plus the scenario's deterministic expectations. */
function validateProcessExpectations(
  id: string,
  output: Record<string, unknown>,
  requirements: ScenarioRequirements,
): void {
  const expect = requirements.process_expectations ?? {}
  if (output.recommendations !== undefined) {
    const recs = output.recommendations as Array<{ task_id: number; project_id: number | null }>
    if (!Array.isArray(recs)) throw new Error(`[${id}] recommendations must be an array`)
    for (const [taskId, projectId] of Object.entries(expect.projects ?? {})) {
      const rec = recs.find((r) => r.task_id === Number(taskId))
      const got = rec ? rec.project_id : null
      if (got !== projectId) {
        throw new Error(`[${id}] task ${taskId}: expected project ${projectId}, got ${got}`)
      }
    }
    return
  }
  const groups = output.groups as Array<{ task_ids: number[] }>
  if (!Array.isArray(groups)) throw new Error(`[${id}] groups must be an array`)
  for (const wanted of expect.duplicate_groups ?? []) {
    if (!groups.some((g) => wanted.every((tid) => g.task_ids.includes(tid)))) {
      throw new Error(`[${id}] expected ${JSON.stringify(wanted)} grouped together`)
    }
  }
  for (const [a, b] of expect.not_duplicates ?? []) {
    if (groups.some((g) => g.task_ids.includes(a) && g.task_ids.includes(b))) {
      throw new Error(`[${id}] ${a} and ${b} must not be grouped as duplicates`)
    }
  }
}

/**
 * `must_include` matchers for values a scenario cannot spell exactly:
 * - `~date:YYYY-MM-DD` — a local datetime on that day, any time (scenarios
 *   compute the day relative to the run; the time is left to Layer 2 notes)
 * - `~datetime:YYYY-MM-DDTHH:MM` — a local datetime at that minute (seconds
 *   free): a time with no day, whose day depends on when the run starts
 * - `~notnull` — set to anything
 * - `~soon` — "now": about 15 minutes after the scenario's now, rounded UP to
 *   the next quarter hour (exactly that minute; `resolveSoonTarget` does it)
 * - `~in-hours:N` — "in N hours": now + N hours, rounded up to the quarter hour
 * - `~hours-range:LO-HI` — "in an hour or two" (1-2), "in 2 or 3 hours"
 *   (2-3): a time on a quarter hour inside the range. The model picks; the
 *   prompt asks for a whole hour, and Layer 2 judges that preference. Both
 *   ends count (at 2:30, "an hour or two" may be 3:30 or 4:00 — designer,
 *   2026-10-16); `resolveSoonTarget` replaces a pick outside the range.
 *
 * The time matchers need `clock` — the scenario's now and timezone.
 */
function checkSpecialExpectation(
  id: string,
  key: string,
  expected: string,
  actual: unknown,
  clock?: { now: Date; timezone: string },
): void {
  if (expected === '~soon' || /^~(in-hours|hours-range):/.test(expected)) {
    checkSoonExpectation(id, key, expected, actual, clock)
    return
  }
  if (expected.startsWith('~date:')) {
    const day = expected.slice('~date:'.length)
    if (typeof actual !== 'string' || actual.slice(0, 10) !== day) {
      throw new Error(`[${id}] Expected ${key} on ${day}, got ${JSON.stringify(actual)}`)
    }
    return
  }
  if (expected.startsWith('~datetime:')) {
    const minute = expected.slice('~datetime:'.length)
    if (typeof actual !== 'string' || actual.slice(0, 16) !== minute) {
      throw new Error(`[${id}] Expected ${key} at ${minute}, got ${JSON.stringify(actual)}`)
    }
    return
  }
  if (expected === '~notnull') {
    if (actual == null) throw new Error(`[${id}] Expected ${key} to be set, got ${actual}`)
    return
  }
  // '~lacks:every other day' / '~has:weekly' — a string field (a title) without
  // or with that text, case-insensitive (2026-10-16, repeat words in titles).
  const text = /^~(lacks|has):(.*)$/.exec(expected)
  if (text) {
    const contains =
      typeof actual === 'string' && actual.toLowerCase().includes(text[2].toLowerCase())
    if (contains !== (text[1] === 'has')) {
      throw new Error(
        `[${id}] Expected ${key} to ${text[1] === 'has' ? 'contain' : 'not contain'} "${text[2]}", got ${JSON.stringify(actual)}`,
      )
    }
    return
  }
  // '~rrule-has:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH' — every listed part is in
  // the rule, in any order (other parts, e.g. a BYHOUR, may be there too).
  if (expected.startsWith('~rrule-has:')) {
    const want = expected.slice('~rrule-has:'.length).toUpperCase().split(';')
    const have = typeof actual === 'string' ? actual.toUpperCase().split(';') : []
    const missing = want.filter((part) => !have.includes(part))
    if (missing.length > 0) {
      throw new Error(`[${id}] Expected ${key} to have ${missing.join(';')}, got ${actual}`)
    }
    return
  }
  throw new Error(`[${id}] Unknown matcher ${expected} for ${key}`)
}

/** The first quarter-hour mark at or after `t`, to the minute. */
function ceilQuarter(t: DateTime): DateTime {
  const minute = t.startOf('minute')
  const over = minute.minute % 15
  return over === 0 ? minute : minute.plus({ minutes: 15 - over })
}

/** The `~soon`, `~in-hours:N` and `~hours-range:LO-HI` matchers (see above). */
function checkSoonExpectation(
  id: string,
  key: string,
  expected: string,
  actual: unknown,
  clock?: { now: Date; timezone: string },
): void {
  if (!clock) throw new Error(`[${id}] ${expected} needs the scenario's now and timezone`)
  const now = DateTime.fromJSDate(clock.now).setZone(clock.timezone).startOf('minute')
  const fmt = (t: DateTime) => t.toFormat("yyyy-MM-dd'T'HH:mm")
  const got = typeof actual === 'string' ? DateTime.fromISO(actual, { zone: clock.timezone }) : null
  if (!got || !got.isValid) {
    throw new Error(`[${id}] Expected ${key} ${expected} at now ${fmt(now)}, got ${actual}`)
  }
  if (expected === '~soon' || expected.startsWith('~in-hours:')) {
    const hours = expected === '~soon' ? 0 : Number(expected.slice('~in-hours:'.length))
    const want = ceilQuarter(expected === '~soon' ? now.plus({ minutes: 15 }) : now.plus({ hours }))
    if (fmt(got) !== fmt(want)) {
      throw new Error(`[${id}] Expected ${key} at ${fmt(want)} (now ${fmt(now)}), got ${actual}`)
    }
    return
  }
  const [lo, hi] = expected.slice('~hours-range:'.length).split('-').map(Number)
  const earliest = now.plus({ hours: lo })
  const latest = now.plus({ hours: hi })
  if (got.minute % 15 !== 0 || got < earliest || got > latest) {
    throw new Error(
      `[${id}] Expected ${key} on a quarter hour in ${fmt(earliest)}..${fmt(latest)} (now ${fmt(now)}), got ${actual}`,
    )
  }
}

/** Task model fields (2026-10-10): deadline_at a datetime or null, horizon an enum or null. */
function validateTaskModelFields(id: string, output: Record<string, unknown>): void {
  const deadline = output.deadline_at
  if (deadline !== null && (typeof deadline !== 'string' || isNaN(Date.parse(deadline)))) {
    throw new Error(`[${id}] deadline_at must be an ISO 8601 datetime or null, got ${deadline}`)
  }
  if (
    output.horizon !== null &&
    !['days', 'weeks', 'months', 'eventually'].includes(output.horizon as string)
  ) {
    throw new Error(`[${id}] horizon must be days|weeks|months|eventually or null`)
  }
  validateRelativeTarget(id, output)
}

/**
 * Relative targets (2026-10-24): both offsets or neither; set only beside a
 * deadline, with no target, no deck and no rule (what production stores).
 */
function validateRelativeTarget(id: string, output: Record<string, unknown>): void {
  const days = output.target_days_before
  const time = output.target_time
  if ((days === null) !== (time === null)) {
    throw new Error(`[${id}] target_days_before and target_time come together`)
  }
  if (days === null) return
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
    throw new Error(`[${id}] target_days_before must be a whole number of days, got ${days}`)
  }
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`[${id}] target_time must be HH:MM, got ${time}`)
  }
  if (output.deadline_at === null || output.rrule !== null) {
    throw new Error(`[${id}] a relative target needs a deadline and no rule`)
  }
  if (output.due_at !== null || output.on_deck_day !== null) {
    throw new Error(`[${id}] a relative target leaves due_at and on_deck_day null`)
  }
}

/** On deck (D3, 2026-10-20): `on_deck_day` a local day or null, never beside a target. */
function validateDeckField(id: string, output: Record<string, unknown>): void {
  const deck = output.on_deck_day
  if (deck !== null && (typeof deck !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deck))) {
    throw new Error(`[${id}] on_deck_day must be yyyy-MM-dd or null, got ${deck}`)
  }
  if (deck !== null && output.due_at !== null) {
    throw new Error(`[${id}] on_deck_day and due_at are never both set`)
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
  validateTaskModelFields(id, output)
  validateDeckField(id, output)
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

function validateWhatsNextSchema(id: string, output: Record<string, unknown>): void {
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

function validateInsightsSchema(
  id: string,
  output: Record<string, unknown>,
  input: InsightsInput,
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

function validateQuickTakeSchema(id: string, output: Record<string, unknown>): void {
  if (typeof output.text !== 'string' || output.text.length === 0) {
    throw new Error(`[${id}] text must be a non-empty string`)
  }
  // Quick take should be a single sentence, max 25 words (~350 chars generous upper bound)
  if (output.text.length > 350) {
    throw new Error(
      `[${id}] text is ${output.text.length} chars — expected a short sentence (max ~250 chars)`,
    )
  }
}

/**
 * Validate deterministic insights expectations — both always-on rules
 * and per-scenario checks from insights_expectations.
 */
function validateInsightsExpectations(
  id: string,
  output: Record<string, unknown>,
  input: InsightsInput,
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

  // --- Always-on checks (every insights scenario) ---

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

    // act_soon gate — mirrors actSoonAllowed() in src/core/ai/insights.ts
    // (2026-10-10): a stored deadline within 7 days allows it at any priority,
    // a further one forbids it; with no deadline it needs P3+.
    if (signals.includes('act_soon') && !actSoonAllowedHere(task)) {
      throw new Error(
        `[${id}] task ${item.task_id} ("${task.title}") has "act_soon" signal but is P${task.priority} ` +
          `with deadline ${String(task.deadline_at)} (act_soon needs a deadline within 7 days, or P3+ without one)`,
      )
    }
  }

  // Score spread: for 10+ tasks, std dev must be > 10
  // Skip this check for scenarios with min_zero_signal_pct >= 60 — those are
  // intentionally homogeneous (all routine tasks) where low variance is expected.
  const isHomogeneous =
    requirements.insights_expectations?.min_zero_signal_pct != null &&
    requirements.insights_expectations.min_zero_signal_pct >= 60
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

  // --- Per-scenario checks (when insights_expectations is set) ---

  const expectations = requirements.insights_expectations
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

/** Read provider from env var, defaulting to 'sdk' (preserves existing behavior). */
function getTestProvider(): 'sdk' | 'anthropic' | 'openai' {
  const p = process.env.OPENTASK_AI_PROVIDER
  if (p === 'anthropic' || p === 'openai') return p
  return 'sdk'
}

function getModelForFeature(feature: string): string {
  const validFeatures: AIFeature[] = [
    'enrichment',
    'quick_take',
    'whats_next',
    'insights',
    'process',
  ]
  const f: AIFeature = validFeatures.includes(feature as AIFeature)
    ? (feature as AIFeature)
    : 'enrichment'

  // SDK mode uses resolveSDKModel (has sensible defaults, never throws).
  // API mode uses requireFeatureModel (requires explicit env var per feature).
  if (getTestProvider() === 'sdk') {
    return resolveSDKModel(f)
  }
  return requireFeatureModel(f)
}
