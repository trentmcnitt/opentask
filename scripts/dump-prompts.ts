/**
 * Dump all AI prompts as rendered text.
 *
 * Usage:
 *   npx tsx scripts/dump-prompts.ts                     # dump all prompt templates
 *   npx tsx scripts/dump-prompts.ts --feature insights  # dump just the insights prompt
 *   npx tsx scripts/dump-prompts.ts --scenario <id>     # render with a quality test scenario's data
 *   npx tsx scripts/dump-prompts.ts --list              # list available scenarios
 *
 * Output goes to .tmp/prompts.txt (or .tmp/prompts-<scenario>.txt with --scenario).
 *
 * --feature: enrichment, insights, or whats_next. Limits output to one prompt type.
 *            Can be combined with --scenario.
 *
 * Examples:
 *   npx tsx scripts/dump-prompts.ts
 *   npx tsx scripts/dump-prompts.ts --feature enrichment
 *   npx tsx scripts/dump-prompts.ts --feature insights --scenario insights-medium-list
 *   npx tsx scripts/dump-prompts.ts --scenario insights-consequences
 */

import { writeFileSync, mkdirSync } from 'fs'
import { DateTime } from 'luxon'
import {
  ENRICHMENT_SYSTEM_PROMPT,
  WHATS_NEXT_SYSTEM_PROMPT,
  INSIGHTS_SYSTEM_PROMPT,
  ENRICHMENT_REMINDERS,
  WHATS_NEXT_REMINDERS,
  INSIGHTS_REMINDERS,
} from '../src/core/ai/prompts'
import { formatTaskLine } from '../src/core/ai/format'
import {
  buildQuickTakePrompt,
  buildQuickTakeUserPrompt,
  formatCompactTaskList,
  buildTaskStats,
  QUICK_TAKE_SYSTEM_PROMPT,
} from '../src/core/ai/quick-take'
import type { TaskSummary } from '../src/core/ai/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function separator(title: string): string {
  const line = '='.repeat(80)
  return `\n${line}\n  ${title}\n${line}\n`
}

function charCount(text: string): string {
  return `[${text.length.toLocaleString()} chars]`
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

interface ScenarioInput {
  id: string
  feature: string
  input: {
    timezone: string
    tasks?: Array<{
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
      recurrence_mode: string
    }>
    text?: string
    newTaskTitle?: string
    userContext?: string
  }
}

async function loadScenarios(): Promise<ScenarioInput[]> {
  const { allScenarios } = await import('../tests/quality/scenarios/index')
  return allScenarios as ScenarioInput[]
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function renderEnrichmentPrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || 'America/Chicago'
  const currentUtcTime = new Date().toISOString()
  const rawInput = scenario?.input.text || '<raw task text would appear here>'
  const userContextBlock = scenario?.input.userContext
    ? `\nUser context: ${scenario.input.userContext}\n`
    : ''

  // The enrichment prompt uses ENRICHMENT_SYSTEM_PROMPT as a system prompt (separate),
  // and the user prompt is assembled with context + task text + reminders
  const systemPrompt = ENRICHMENT_SYSTEM_PROMPT

  const userPrompt = `## Context

User's timezone: ${timezone}
Current UTC time: ${currentUtcTime}

User's schedule:
- Default task time: 9:00 AM (when no specific time is mentioned, use this)
- Wakes up: 7:00 AM
- Goes to sleep: 10:30 PM

When resolving time-of-day language:
- "tomorrow" with no time specified → default task time (9:00 AM)
- "morning" → default task time (9:00 AM)
- "afternoon" → use your judgment, typically early afternoon
- "evening" → use your judgment, typically early evening
- "tonight" / "bedtime" / "before bed" → sleep time (10:30 PM)

Available projects:
- Home (id: 1)
- Work (id: 2)${userContextBlock}

<task>
${rawInput}
</task>

${ENRICHMENT_REMINDERS}
User's timezone: ${timezone} | Current UTC time: ${currentUtcTime}
Parse the task above and return the structured result.`

  return `${separator('ENRICHMENT — System Prompt ' + charCount(systemPrompt))}
${systemPrompt}

${separator('ENRICHMENT — User Prompt ' + charCount(userPrompt))}
${userPrompt}`
}

function renderWhatsNextPrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || 'America/Chicago'
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const tasks = scenario?.input.tasks || []
  const taskList = tasks.map((t) => formatTaskLine(t as TaskSummary, timezone, now)).join('\n')
  const userContextBlock = scenario?.input.userContext
    ? `\nUser context: ${scenario.input.userContext}\n`
    : ''
  const taskPlaceholder = tasks.length > 0 ? taskList : '<task lines would appear here>'

  const prompt = `${WHATS_NEXT_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total active tasks: ${tasks.length || '<N>'}
The user is actively looking for what to do next. Focus on what is actionable right now.
${userContextBlock}
<tasks>
${taskPlaceholder}
</tasks>

${WHATS_NEXT_REMINDERS}
Current time: ${currentTime}
Surface 2-8 tasks and return the JSON result.`

  return `${separator("WHAT'S NEXT — Full Prompt " + charCount(prompt))}
${prompt}`
}

function renderInsightsPrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || 'America/Chicago'
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const tasks = scenario?.input.tasks || []
  const taskLines = tasks.map((t) => formatTaskLine(t as TaskSummary, timezone, now)).join('\n')
  const userContextBlock = scenario?.input.userContext
    ? `\nUser context: ${scenario.input.userContext}\n`
    : ''
  const taskPlaceholder = tasks.length > 0 ? taskLines : '<task lines would appear here>'

  const prompt = `${INSIGHTS_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total tasks: ${tasks.length || '<N>'}${userContextBlock}
<tasks>
${taskPlaceholder}
</tasks>

${INSIGHTS_REMINDERS}
Current time: ${currentTime}
Score every task above. Return a JSON array with one entry per task.`

  return `${separator('INSIGHTS — Full Prompt ' + charCount(prompt))}
${prompt}`
}

function renderQuickTakePrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || 'America/Chicago'
  const tasks = scenario?.input.tasks || []
  const newTaskTitle =
    scenario?.feature === 'quick_take' && scenario.input.newTaskTitle
      ? scenario.input.newTaskTitle
      : '<new task title>'

  const tasksForPrompt = tasks.map((t) => ({
    title: t.title,
    project_name: t.project_name ?? null,
    due_at: t.due_at,
    priority: t.priority,
    labels: t.labels,
  }))
  const { text: compactTaskList, count } = formatCompactTaskList(tasksForPrompt, timezone)
  const stats = buildTaskStats(tasksForPrompt, timezone)
  const fullPrompt = buildQuickTakePrompt(
    compactTaskList,
    count,
    timezone,
    newTaskTitle,
    stats,
    false,
  )
  const userPrompt = buildQuickTakeUserPrompt(
    compactTaskList,
    count,
    timezone,
    newTaskTitle,
    stats,
    false,
  )

  return `${separator('QUICK TAKE — Full Prompt (cold path) ' + charCount(fullPrompt))}
${fullPrompt}

${separator('QUICK TAKE — System Prompt (warm slot) ' + charCount(QUICK_TAKE_SYSTEM_PROMPT))}
${QUICK_TAKE_SYSTEM_PROMPT}

${separator('QUICK TAKE — User Prompt (warm slot) ' + charCount(userPrompt))}
${userPrompt}`
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const VALID_FEATURES = ['enrichment', 'insights', 'whats_next', 'quick_take']

async function listScenarios(): Promise<void> {
  const scenarios = await loadScenarios()
  console.log(`\nAvailable scenarios (${scenarios.length} total):\n`)
  const byFeature = new Map<string, string[]>()
  for (const s of scenarios) {
    const list = byFeature.get(s.feature) || []
    const taskCount = s.input.tasks?.length || 0
    list.push(`  ${s.id}${taskCount ? ` (${taskCount} tasks)` : ''}`)
    byFeature.set(s.feature, list)
  }
  for (const [feature, ids] of byFeature) {
    console.log(`${feature}:`)
    ids.forEach((id) => console.log(id))
    console.log()
  }
}

function parseArgs(args: string[]) {
  const scenarioIdx = args.indexOf('--scenario')
  const featureIdx = args.indexOf('--feature')
  const featureFilter = featureIdx !== -1 ? args[featureIdx + 1] : null

  if (featureFilter && !VALID_FEATURES.includes(featureFilter)) {
    console.error(
      `Unknown feature "${featureFilter}". Valid features: ${VALID_FEATURES.join(', ')}`,
    )
    process.exit(1)
  }

  return {
    listMode: args.includes('--list'),
    scenarioId: scenarioIdx !== -1 ? args[scenarioIdx + 1] : null,
    featureFilter,
  }
}

function renderPrompts(
  featuresToRender: string[],
  scenario: ScenarioInput | undefined,
  featureFilter: string | null,
): string {
  let output = `AI Prompt Dump — ${new Date().toISOString()}\n`
  if (scenario) {
    output += `Scenario: ${scenario.id} (${scenario.feature})\n`
    output += `Tasks: ${scenario.input.tasks?.length || 0}\n`
  } else {
    output += `Mode: templates only (use --scenario <id> to render with test data)\n`
  }
  if (featureFilter) {
    output += `Feature filter: ${featureFilter}\n`
  }

  if (featuresToRender.includes('enrichment')) {
    output += renderEnrichmentPrompt(scenario?.feature === 'enrichment' ? scenario : undefined)
  }
  if (featuresToRender.includes('whats_next')) {
    output += renderWhatsNextPrompt(scenario?.feature === 'whats_next' ? scenario : undefined)
  }
  if (featuresToRender.includes('insights')) {
    output += renderInsightsPrompt(scenario?.feature === 'insights' ? scenario : undefined)
  }
  if (featuresToRender.includes('quick_take')) {
    output += renderQuickTakePrompt(scenario?.feature === 'quick_take' ? scenario : undefined)
  }

  return output
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { listMode, scenarioId, featureFilter } = parseArgs(process.argv.slice(2))

  if (listMode) {
    await listScenarios()
    return
  }

  let scenario: ScenarioInput | undefined
  if (scenarioId) {
    const scenarios = await loadScenarios()
    scenario = scenarios.find((s) => s.id === scenarioId)
    if (!scenario) {
      console.error(`Scenario "${scenarioId}" not found. Use --list to see available scenarios.`)
      process.exit(1)
    }
  }

  mkdirSync('.tmp', { recursive: true })

  const featuresToRender = featureFilter
    ? [featureFilter]
    : scenario
      ? [scenario.feature]
      : VALID_FEATURES

  const output = renderPrompts(featuresToRender, scenario, featureFilter)
  const suffix = [scenario?.id, featureFilter].filter(Boolean).join('-')
  const filename = suffix ? `.tmp/prompts-${suffix}.txt` : '.tmp/prompts.txt'
  writeFileSync(filename, output)
  console.log(`Written to ${filename} (${output.length.toLocaleString()} chars)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
