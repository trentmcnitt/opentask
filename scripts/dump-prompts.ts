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
 *
 * All prompt text comes from the production code paths — this script only
 * supplies placeholder data when no scenario is provided.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { DateTime } from 'luxon'
import { ENRICHMENT_SYSTEM_PROMPT, buildEnrichmentUserPrompt } from '../src/core/ai/prompts'
import { buildWhatsNextFullPrompt } from '../src/core/ai/whats-next'
import { buildInsightsFullPrompt } from '../src/core/ai/insights'
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
// Default placeholder values (used only when no scenario is provided)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  timezone: 'America/Chicago',
  morningTime: '09:00',
  wakeTime: '07:00',
  sleepTime: '22:00',
  projects: [
    { id: 1, name: 'Home' },
    { id: 2, name: 'Work' },
  ],
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
    morningTime?: string
    wakeTime?: string
    sleepTime?: string
    projects?: Array<{ id: number; name: string; shared?: boolean }>
  }
}

async function loadScenarios(): Promise<ScenarioInput[]> {
  const { allScenarios } = await import('../tests/quality/scenarios/index')
  return allScenarios as ScenarioInput[]
}

// ---------------------------------------------------------------------------
// Prompt rendering — all use production builder functions
// ---------------------------------------------------------------------------

function renderEnrichmentPrompt(scenario?: ScenarioInput): string {
  const userPrompt = buildEnrichmentUserPrompt({
    timezone: scenario?.input.timezone || DEFAULTS.timezone,
    morningTime: scenario?.input.morningTime ?? DEFAULTS.morningTime,
    wakeTime: scenario?.input.wakeTime ?? DEFAULTS.wakeTime,
    sleepTime: scenario?.input.sleepTime ?? DEFAULTS.sleepTime,
    projects: scenario?.input.projects ?? DEFAULTS.projects,
    userContext: scenario?.input.userContext,
    taskText: scenario?.input.text || '<raw task text would appear here>',
  })

  const systemPrompt = ENRICHMENT_SYSTEM_PROMPT

  return `${separator('ENRICHMENT — System Prompt ' + charCount(systemPrompt))}
${systemPrompt}

${separator('ENRICHMENT — User Prompt ' + charCount(userPrompt))}
${userPrompt}`
}

function renderWhatsNextPrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || DEFAULTS.timezone
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const tasks = scenario?.input.tasks || []
  const taskList =
    tasks.length > 0
      ? tasks.map((t) => formatTaskLine(t as TaskSummary, timezone, now)).join('\n')
      : '<task lines would appear here>'

  const prompt = buildWhatsNextFullPrompt({
    currentTime,
    totalTaskCount: tasks.length || '<N>',
    taskList,
    userContext: scenario?.input.userContext,
  })

  return `${separator("WHAT'S NEXT — Full Prompt " + charCount(prompt))}
${prompt}`
}

function renderInsightsPrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || DEFAULTS.timezone
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const tasks = scenario?.input.tasks || []
  const taskLines =
    tasks.length > 0
      ? tasks.map((t) => formatTaskLine(t as TaskSummary, timezone, now)).join('\n')
      : '<task lines would appear here>'

  const prompt = buildInsightsFullPrompt({
    currentTime,
    totalTaskCount: tasks.length || '<N>',
    taskLines,
    userContext: scenario?.input.userContext,
  })

  return `${separator('INSIGHTS — Full Prompt ' + charCount(prompt))}
${prompt}`
}

function renderQuickTakePrompt(scenario?: ScenarioInput): string {
  const timezone = scenario?.input.timezone || DEFAULTS.timezone
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
    rrule: t.rrule ?? null,
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
    tasksForPrompt,
  )
  const userPrompt = buildQuickTakeUserPrompt(
    compactTaskList,
    count,
    timezone,
    newTaskTitle,
    stats,
    false,
    tasksForPrompt,
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
