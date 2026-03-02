/**
 * What's Next AI recommendations
 *
 * Helps the user decide what to focus on next — surfacing tasks that
 * deserve attention, things that are easy to forget, and opportunities
 * to make meaningful progress.
 *
 * Uses per-query subprocess (not the warm enrichment slot) because it runs
 * infrequently (3 AM cron + on-demand refresh). Cache persists in ai_activity_log.
 */

import { nowUtc } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse, extractJsonFromText } from './parse-helpers'
import { WHATS_NEXT_SYSTEM_PROMPT, WHATS_NEXT_REMINDERS } from './prompts'
import { formatTaskLine, getScheduleBlock } from './format'
import { WhatsNextResultSchema } from './types'
import type { WhatsNextResult, TaskSummary } from './types'
import { logAIActivity, getAIActivity } from './activity'
import { getApiProvider, type AIProvider } from './provider'
import { requireFeatureModel } from './models'
import { z } from 'zod'
import { DateTime } from 'luxon'

const WHATS_NEXT_JSON_SCHEMA = z.toJSONSchema(WhatsNextResultSchema) as Record<string, unknown>

/**
 * Generate What's Next recommendations for a user.
 *
 * Sends a summary of the user's active tasks to AI and returns
 * tasks that deserve attention with reasons + summary.
 * Caches the result in ai_activity_log for same-day retrieval.
 */
export async function generateWhatsNext(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  /** Provider to use for this call. 'sdk' or an API provider name. */
  provider?: AIProvider,
  /** Whether this is a scheduled cron run or an on-demand user request. */
  source?: 'scheduled' | 'on-demand',
): Promise<WhatsNextResult | null> {
  if (tasks.length === 0) {
    return {
      tasks: [],
      summary: 'No active tasks. Enjoy your free time!',
      generated_at: nowUtc(),
    }
  }

  // Filter to tasks due within 7 days or already overdue/no due date
  const relevantTasks = selectRelevantTasks(tasks)
  if (relevantTasks.length === 0) {
    return {
      tasks: [],
      summary: 'All tasks are scheduled for later. Nothing needs attention right now.',
      generated_at: nowUtc(),
    }
  }

  const now = DateTime.now().setZone(timezone)
  const taskList = relevantTasks.map((t) => formatTaskLine(t, timezone, now)).join('\n')

  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")

  const userContextBlock = userContext ? `\nUser context: ${userContext}\n` : ''

  const scheduleBlock = getScheduleBlock(userId)

  const sourceBlock =
    source === 'scheduled'
      ? '\nThis is an automated briefing. Focus on what the user should have on their radar for the day ahead.\n'
      : '\nThe user is actively looking for what to do next. Focus on what is actionable right now.\n'

  const prompt = `${WHATS_NEXT_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total active tasks: ${tasks.length}${scheduleBlock}${sourceBlock}${userContextBlock}
<tasks>
${taskList}
</tasks>

${WHATS_NEXT_REMINDERS}
Current time: ${currentTime}
Surface 0-8 tasks and return the JSON result.`

  const effectiveProvider = provider ?? getApiProvider()
  const whatsNextModel = requireFeatureModel('whats_next', effectiveProvider)
  const result = await aiQuery({
    prompt,
    outputSchema: WHATS_NEXT_JSON_SCHEMA,
    model: whatsNextModel,
    maxTurns: 1,
    // Enable extended thinking for Opus models to improve recommendation quality
    ...(whatsNextModel.includes('opus') && { maxThinkingTokens: 10000 }),
    userId,
    action: 'whats_next',
    inputText: `${tasks.length} tasks`,
    provider: effectiveProvider,
  })

  // The AI sometimes returns text with JSON in a markdown code block rather than
  // structured output, and may use alternative field names (e.g., "tasks_to_surface"
  // instead of "tasks") or omit optional fields like "summary". The textFallback
  // normalizes these variations before Zod validation.
  const parsed = parseAIResponse(result, WhatsNextResultSchema, "What's Next", (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null

    // Normalize alternative field names the AI sometimes uses
    if ('tasks_to_surface' in json && !('tasks' in json)) {
      json.tasks = json.tasks_to_surface
      delete json.tasks_to_surface
    }

    // Provide default generated_at if missing
    if (!json.generated_at) {
      json.generated_at = nowUtc()
    }

    const attempt = WhatsNextResultSchema.safeParse(json)
    return attempt.success ? attempt.data : null
  })
  if (!parsed) return null

  // Filter to only include tasks that exist in the provided list
  const taskIds = new Set(tasks.map((t) => t.id))
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const validTasks = parsed.tasks.filter((t) => {
    if (!taskIds.has(t.task_id)) return false
    // Defense-in-depth: strip daily habits the AI may have surfaced
    const task = taskMap.get(t.task_id)
    if (task?.rrule?.startsWith('FREQ=DAILY') && !task.rrule.match(/INTERVAL=([2-9]|\d{2,})/)) {
      return false
    }
    return true
  })
  const validResult: WhatsNextResult = {
    tasks: validTasks,
    summary: parsed.summary,
    generated_at: parsed.generated_at || nowUtc(),
  }

  // Cache the post-processed result in ai_activity_log for same-day retrieval
  // via getCachedWhatsNext(). Note: aiQuery() already logged the raw AI response;
  // this second entry stores the filtered/validated result that the UI actually uses.
  logAIActivity({
    user_id: userId,
    task_id: null,
    action: 'whats_next',
    status: 'success',
    input: `${tasks.length} tasks`,
    output: JSON.stringify(validResult),
    model: whatsNextModel,
    duration_ms: result.durationMs,
    error: null,
    provider: effectiveProvider,
  })

  return validResult
}

/**
 * Get cached What's Next result for a user.
 *
 * Returns the most recent successful What's Next result from today,
 * or null if none exists or it's stale.
 */
export function getCachedWhatsNext(
  userId: number,
): { result: WhatsNextResult; durationMs: number | null } | null {
  const entries = getAIActivity(userId, { action: 'whats_next', limit: 1 })
  if (entries.length === 0) return null

  const entry = entries[0]
  if (entry.status !== 'success' || !entry.output) return null

  // Check if it was generated today
  const generatedDate = new Date(entry.created_at!).toISOString().split('T')[0]
  const todayDate = new Date().toISOString().split('T')[0]
  if (generatedDate !== todayDate) return null

  try {
    const parsed = WhatsNextResultSchema.safeParse(JSON.parse(entry.output))
    if (parsed.success) {
      return { result: parsed.data, durationMs: entry.duration_ms ?? null }
    }
  } catch {
    // Invalid cached data
  }

  return null
}

/**
 * Select tasks relevant for the What's Next prompt.
 *
 * Simple filter: include everything except tasks due more than 7 days out.
 * Overdue tasks, tasks due within 7 days, and tasks with no due date are all included.
 * The AI prompt itself handles prioritization and exclusion logic.
 */
function selectRelevantTasks(tasks: TaskSummary[]): TaskSummary[] {
  const cutoff = Date.now() + 7 * 24 * 60 * 60 * 1000
  return tasks.filter((t) => !t.due_at || new Date(t.due_at).getTime() <= cutoff)
}
