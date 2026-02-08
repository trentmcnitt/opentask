/**
 * "What's Next?" AI recommendations
 *
 * Analyzes the user's active tasks and recommends 3-7 items that
 * actually matter today. Uses Haiku for fast on-demand responses.
 * Results are cached per-user for 5 minutes.
 */

import { log } from '@/lib/logger'
import { aiQuery } from './sdk'
import { extractJsonFromText } from './parse-helpers'
import { WHATS_NEXT_SYSTEM_PROMPT } from './prompts'
import { WhatsNextResultSchema } from './types'
import type { WhatsNextResult, TaskSummary } from './types'
import { z } from 'zod'

/** In-memory cache: userId → { result, timestamp } */
const cache = new Map<number, { result: WhatsNextResult; timestamp: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Generate "What's Next?" recommendations for a user.
 *
 * Sends a summary of the user's active tasks to AI and returns
 * 3-7 recommended tasks with reasons + an overall summary.
 */
export async function generateWhatsNext(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
): Promise<WhatsNextResult | null> {
  // Check cache
  const cached = cache.get(userId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result
  }

  if (tasks.length === 0) {
    return { tasks: [], summary: 'No active tasks. Enjoy your free time!' }
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

  const prompt = `${WHATS_NEXT_SYSTEM_PROMPT}

## Context

User's timezone: ${timezone}
Current UTC time: ${new Date().toISOString()}
Total active tasks: ${tasks.length}

## Tasks

${taskList}

Analyze these tasks and recommend 3-7 items to focus on right now.`

  const jsonSchema = z.toJSONSchema(WhatsNextResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_WHATS_NEXT_MODEL || 'haiku',
    maxTurns: 1,
    userId,
    action: 'whats_next',
    inputText: `${tasks.length} tasks`,
  })

  if (!result.success) {
    log.error('ai', "What's Next generation failed:", result.error)
    return null
  }

  if (!result.structuredOutput && !result.textResult) {
    log.error('ai', "What's Next returned empty output")
    return null
  }

  let output = result.structuredOutput
  if (!output && result.textResult) {
    output = extractJsonFromText(result.textResult)
  }

  const parsed = WhatsNextResultSchema.safeParse(output)

  // If structured/JSON parsing failed, try extracting from markdown text.
  // The model often returns numbered lists: "1. **[46] Title** — reason"
  if (!parsed.success && result.textResult) {
    const mdResult = parseMarkdownRecommendations(result.textResult)
    if (mdResult) {
      const taskIds = new Set(tasks.map((t) => t.id))
      const validResult: WhatsNextResult = {
        tasks: mdResult.tasks.filter((t) => taskIds.has(t.task_id)),
        summary: mdResult.summary,
      }
      cache.set(userId, { result: validResult, timestamp: Date.now() })
      return validResult
    }
    log.error('ai', "Invalid What's Next output:", parsed.error.message)
    return null
  }

  if (!parsed.success) {
    log.error('ai', "What's Next: no output to parse")
    return null
  }

  // Filter to only include tasks that exist in the provided list
  const taskIds = new Set(tasks.map((t) => t.id))
  const validResult: WhatsNextResult = {
    tasks: parsed.data.tasks.filter((t) => taskIds.has(t.task_id)),
    summary: parsed.data.summary,
  }

  // Cache the result
  cache.set(userId, { result: validResult, timestamp: Date.now() })

  return validResult
}

/** Clear cached results (for testing) */
export function clearWhatsNextCache(): void {
  cache.clear()
}

/**
 * Select the most relevant tasks for the AI prompt.
 * Prioritizes: overdue > due today/tomorrow > high priority > stale (high snooze count).
 */
function selectRelevantTasks(tasks: TaskSummary[], limit: number): TaskSummary[] {
  const now = new Date()

  const scored = tasks.map((t) => {
    let score = 0

    // Overdue tasks get highest score
    if (t.due_at && new Date(t.due_at) < now) score += 100

    // Due within 24 hours
    if (t.due_at) {
      const hoursUntilDue = (new Date(t.due_at).getTime() - now.getTime()) / (1000 * 60 * 60)
      if (hoursUntilDue >= 0 && hoursUntilDue <= 24) score += 80
      else if (hoursUntilDue > 24 && hoursUntilDue <= 168) score += 40 // within a week
    }

    // Priority boost
    score += t.priority * 10

    // Stale tasks (snoozed many times)
    score += Math.min(t.snooze_count * 5, 30)

    return { task: t, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.task)
}

/**
 * Parse markdown text output into WhatsNextResult.
 *
 * Handles two common model output formats:
 *   Format A (single-line): "1. **[46] Title** — reason"
 *   Format B (multi-line):
 *     **[46] Title**
 *     Reason on next line
 *
 * Summary extracted from "**Your situation:**" or "## Summary" sections.
 */
function parseMarkdownRecommendations(text: string): WhatsNextResult | null {
  const tasks: Array<{ task_id: number; reason: string }> = []
  const lines = text.split('\n')

  // Format A: single-line "**[46] Title** — reason"
  const singleLinePattern = /\*?\*?\[(\d+)\][^*]*\*?\*?\s*[—–-]+\s*(.+)/g
  let match
  while ((match = singleLinePattern.exec(text)) !== null) {
    const taskId = parseInt(match[1], 10)
    const reason = match[2].trim().replace(/\*+/g, '')
    if (!isNaN(taskId) && reason) tasks.push({ task_id: taskId, reason })
  }

  // Format B: multi-line — title with [N] on one line, reason on the next
  if (tasks.length === 0) {
    const headerPattern = /\*?\*?\[(\d+)\]/
    for (let i = 0; i < lines.length; i++) {
      const hMatch = headerPattern.exec(lines[i])
      if (hMatch) {
        const taskId = parseInt(hMatch[1], 10)
        // Look for reason on the next non-empty line
        let reason = ''
        for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
          const trimmed = lines[j].trim()
          if (trimmed && !headerPattern.test(trimmed) && !trimmed.startsWith('---')) {
            reason = trimmed.replace(/\*+/g, '')
            break
          }
        }
        if (!isNaN(taskId) && reason) tasks.push({ task_id: taskId, reason })
      }
    }
  }

  if (tasks.length === 0) return null

  // Extract summary from "**Your situation:**" or "## Summary" patterns
  let summary = `Focus on ${tasks.length} key tasks today.`
  const situationMatch = text.match(/\*\*Your situation:\*\*\s*(.+)/i)
  if (situationMatch) {
    summary = situationMatch[1].trim()
  } else {
    const headingMatch = text.match(/##\s*(?:Your Situation|Summary)[^\n]*\n+([^\n]+)/)
    if (headingMatch) summary = headingMatch[1].trim()
  }

  return { tasks, summary }
}
