/**
 * AI task triage — reorder tasks by importance
 *
 * Used by the "AI Pick" filter chip on the dashboard. Sends a summary
 * of the user's tasks to AI and returns them ordered by importance.
 */

import { log } from '@/lib/logger'
import { aiQuery } from './sdk'
import { extractJsonFromText } from './parse-helpers'
import { TRIAGE_SYSTEM_PROMPT } from './prompts'
import { TriageResultSchema } from './types'
import type { TriageResult, TaskSummary } from './types'
import { z } from 'zod'

/** In-memory cache: userId → { result, timestamp } */
const cache = new Map<number, { result: TriageResult; timestamp: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Triage tasks by AI-assessed importance.
 *
 * Returns an ordered list of task IDs (most important first) with
 * a brief reasoning explanation. Results are cached for 5 minutes.
 */
export async function triageTasks(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
): Promise<TriageResult | null> {
  // Check cache
  const cached = cache.get(userId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result
  }

  if (tasks.length === 0) {
    return { ordered_task_ids: [], reasoning: 'No active tasks.' }
  }

  // Select most relevant tasks (limit context to ~50)
  const relevantTasks = tasks.slice(0, 50)
  const taskList = relevantTasks
    .map(
      (t) =>
        `- [${t.id}] "${t.title}" | p${t.priority} | due: ${t.due_at || '-'} | ` +
        `snoozed: ${t.snooze_count}x | project: ${t.project_name || 'Inbox'} | ` +
        `recurring: ${t.is_recurring ? 'y' : 'n'} | labels: ${t.labels.join(', ') || '-'}`,
    )
    .join('\n')

  const prompt = `${TRIAGE_SYSTEM_PROMPT}

## Context

User's timezone: ${timezone}
Current UTC time: ${new Date().toISOString()}
Total active tasks: ${tasks.length} (showing top ${relevantTasks.length})

## Tasks

${taskList}

Return these tasks ordered by importance (most important first).`

  const jsonSchema = z.toJSONSchema(TriageResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_TRIAGE_MODEL || 'haiku',
    maxTurns: 1,
    userId,
    action: 'triage',
    inputText: `${tasks.length} tasks`,
  })

  if (!result.success) {
    log.error('ai', 'Triage failed:', result.error)
    return null
  }

  if (!result.structuredOutput && !result.textResult) {
    log.error('ai', 'Triage returned empty output')
    return null
  }

  let output = result.structuredOutput
  if (!output && result.textResult) {
    output = extractJsonFromText(result.textResult)
  }

  const parsed = TriageResultSchema.safeParse(output)

  // If structured/JSON parsing failed, try extracting task IDs from markdown.
  // The model often returns: "1. [46] Task Title" or "1. **[46]** ..."
  if (!parsed.success && result.textResult) {
    const idPattern = /\[(\d+)\]/g
    const ids: number[] = []
    let idMatch
    while ((idMatch = idPattern.exec(result.textResult)) !== null) {
      ids.push(parseInt(idMatch[1], 10))
    }
    if (ids.length > 0) {
      const validIds = new Set(tasks.map((t) => t.id))
      const triageResult: TriageResult = {
        ordered_task_ids: ids.filter((id) => validIds.has(id)),
        reasoning: 'AI-ordered by importance',
      }
      cache.set(userId, { result: triageResult, timestamp: Date.now() })
      return triageResult
    }
    log.error('ai', 'Invalid triage output:', parsed.error.message)
    return null
  }

  if (!parsed.success) {
    log.error('ai', 'Triage: no output to parse')
    return null
  }

  // Filter to valid task IDs
  const validIds = new Set(tasks.map((t) => t.id))
  const triageResult: TriageResult = {
    ordered_task_ids: parsed.data.ordered_task_ids.filter((id) => validIds.has(id)),
    reasoning: parsed.data.reasoning,
  }

  cache.set(userId, { result: triageResult, timestamp: Date.now() })

  return triageResult
}

/** Clear cached results (for testing) */
export function clearTriageCache(): void {
  cache.clear()
}
