/**
 * Bubble AI recommendations
 *
 * Surfaces tasks that would be easily overlooked — social obligations,
 * repeatedly snoozed items, idle tasks, and things without hard deadlines
 * that would become regrets. Replaces the previous "What's Next?" feature.
 *
 * Uses per-query subprocess (not the warm enrichment slot) because it runs
 * infrequently (3 AM cron + on-demand refresh). Cache persists in ai_activity_log.
 */

import { nowUtc } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse } from './parse-helpers'
import { BUBBLE_SYSTEM_PROMPT } from './prompts'
import { BubbleResultSchema } from './types'
import type { BubbleResult, TaskSummary } from './types'
import { logAIActivity, getAIActivity } from './activity'
import { z } from 'zod'

/**
 * Generate Bubble recommendations for a user.
 *
 * Sends a summary of the user's active tasks to AI and returns
 * tasks that are easy to overlook with reasons + summary.
 * Caches the result in ai_activity_log for same-day retrieval.
 */
export async function generateBubble(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
): Promise<BubbleResult | null> {
  if (tasks.length === 0) {
    return {
      tasks: [],
      summary: 'No active tasks. Enjoy your free time!',
      generated_at: nowUtc(),
    }
  }

  // Build a compact task summary for the prompt (limit to 50 most relevant)
  const relevantTasks = selectRelevantTasks(tasks, 50)
  const taskList = relevantTasks
    .map(
      (t) =>
        `- [${t.id}] "${t.title}" | priority: ${t.priority} | due: ${t.due_at || 'none'} | ` +
        `snooze_count: ${t.snooze_count} | labels: ${t.labels.join(', ') || 'none'} | ` +
        `project: ${t.project_name || 'Inbox'} | recurring: ${t.is_recurring ? 'yes' : 'no'}`,
    )
    .join('\n')

  const prompt = `${BUBBLE_SYSTEM_PROMPT}

## Context

User's timezone: ${timezone}
Current UTC time: ${nowUtc()}
Total active tasks: ${tasks.length}

## Tasks

${taskList}

Analyze these tasks and surface 3-7 that are easy to overlook but deserve attention.`

  const jsonSchema = z.toJSONSchema(BubbleResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_BUBBLE_MODEL || 'haiku',
    maxTurns: 1,
    userId,
    action: 'bubble',
    inputText: `${tasks.length} tasks`,
  })

  const parsed = parseAIResponse(result, BubbleResultSchema, 'Bubble')
  if (!parsed) return null

  // Filter to only include tasks that exist in the provided list
  const taskIds = new Set(tasks.map((t) => t.id))
  const validResult: BubbleResult = {
    tasks: parsed.tasks.filter((t) => taskIds.has(t.task_id)),
    summary: parsed.summary,
    generated_at: parsed.generated_at || nowUtc(),
  }

  // Cache in ai_activity_log for same-day retrieval
  logAIActivity({
    user_id: userId,
    task_id: null,
    action: 'bubble',
    status: 'success',
    input: `${tasks.length} tasks`,
    output: JSON.stringify(validResult),
    model: process.env.OPENTASK_AI_BUBBLE_MODEL || 'haiku',
    duration_ms: result.durationMs,
    error: null,
  })

  return validResult
}

/**
 * Get cached Bubble result for a user.
 *
 * Returns the most recent successful Bubble result from today,
 * or null if none exists or it's stale.
 */
export function getCachedBubble(userId: number): BubbleResult | null {
  const entries = getAIActivity(userId, { action: 'bubble', limit: 1 })
  if (entries.length === 0) return null

  const entry = entries[0]
  if (entry.status !== 'success' || !entry.output) return null

  // Check if it was generated today
  const generatedDate = new Date(entry.created_at!).toISOString().split('T')[0]
  const todayDate = new Date().toISOString().split('T')[0]
  if (generatedDate !== todayDate) return null

  try {
    const parsed = BubbleResultSchema.safeParse(JSON.parse(entry.output))
    if (parsed.success) return parsed.data
  } catch {
    // Invalid cached data
  }

  return null
}

/**
 * Select the most relevant tasks for the AI prompt.
 * Prioritizes: stale (high snooze) > idle (no deadline) > low priority.
 * Excludes: daily recurring affirmations, already-urgent items.
 */
function selectRelevantTasks(tasks: TaskSummary[], limit: number): TaskSummary[] {
  const scored = tasks.map((t) => {
    let score = 0

    // High snooze count = being avoided
    score += Math.min(t.snooze_count * 10, 50)

    // No deadline = easy to forget
    if (!t.due_at) score += 20

    // Low priority without deadline = likely overlooked
    if (t.priority <= 1 && !t.due_at) score += 15

    // Non-recurring = won't come back if missed
    if (!t.is_recurring) score += 10

    // Already urgent/high priority = already visible, lower score for Bubble
    if (t.priority >= 3) score -= 20

    // Recurring daily tasks = routine, not interesting for Bubble
    if (t.is_recurring && t.priority === 0) score -= 10

    return { task: t, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.task)
}
