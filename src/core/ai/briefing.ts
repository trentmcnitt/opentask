/**
 * AI daily briefing generation
 *
 * Produces a structured daily briefing with greeting, sections, and
 * actionable items. The briefing is cached for 4 hours and can be
 * stored in the activity log for persistence across restarts.
 */

import { getDb } from '@/core/db'
import { nowUtc, utcToLocal, nowInTimezone } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse } from './parse-helpers'
import { BRIEFING_SYSTEM_PROMPT } from './prompts'
import { BriefingResultSchema } from './types'
import type { BriefingResult, TaskSummary } from './types'
import { z } from 'zod'

const CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours

/**
 * Get the most recent briefing for a user, generating a new one if stale.
 *
 * @param refresh - Force a fresh generation regardless of cache
 */
export async function getBriefing(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  refresh = false,
): Promise<BriefingResult | null> {
  if (!refresh) {
    // Check for a cached briefing in the activity log
    const cached = getCachedBriefing(userId)
    if (cached) return cached
  }

  return generateBriefing(userId, timezone, tasks)
}

/**
 * Generate a fresh daily briefing.
 */
async function generateBriefing(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
): Promise<BriefingResult | null> {
  // Build task statistics for the prompt.
  // Use the user's timezone for "due today" comparison — server timezone may differ.
  const now = new Date()
  const userNow = nowInTimezone(timezone)
  const todayStr = userNow.toISODate()
  const overdueTasks = tasks.filter((t) => t.due_at && new Date(t.due_at) < now)
  const dueTodayTasks = tasks.filter((t) => {
    if (!t.due_at) return false
    if (new Date(t.due_at) < now) return false // overdue, not "today"
    const dueLocal = utcToLocal(t.due_at, timezone)
    return dueLocal.toISODate() === todayStr
  })
  const recurringTasks = tasks.filter((t) => t.is_recurring)
  const highPriorityTasks = tasks.filter((t) => t.priority >= 3)
  const staleTasks = tasks.filter((t) => t.snooze_count >= 5)

  // Build compact task summary (limit context)
  const taskSummary = tasks
    .slice(0, 60)
    .map(
      (t) =>
        `- [${t.id}] "${t.title}" | p${t.priority} | due: ${t.due_at || '-'} | ` +
        `project: ${t.project_name || 'Inbox'} | recurring: ${t.is_recurring ? 'y' : 'n'} | ` +
        `snoozed: ${t.snooze_count}x`,
    )
    .join('\n')

  const prompt = `${BRIEFING_SYSTEM_PROMPT}

## Context

User's timezone: ${timezone}
Current UTC time: ${nowUtc()}

## Stats

- Total active tasks: ${tasks.length}
- Overdue: ${overdueTasks.length}
- Due today: ${dueTodayTasks.length}
- Recurring: ${recurringTasks.length}
- High priority (3-4): ${highPriorityTasks.length}
- Snoozed 5+ times: ${staleTasks.length}

## Tasks

${taskSummary}

Generate a daily briefing for this user.`

  const jsonSchema = z.toJSONSchema(BriefingResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_BRIEFING_MODEL || 'haiku',
    maxTurns: 1,
    userId,
    action: 'briefing',
    inputText: `${tasks.length} tasks`,
  })

  const briefing = parseAIResponse(result, BriefingResultSchema, 'Briefing', parseTextBriefing)

  if (!briefing) return null

  // Cache in the activity log for persistence
  cacheBriefing(userId, briefing)

  return briefing
}

/** Retrieve cached briefing from activity log if within TTL */
function getCachedBriefing(userId: number): BriefingResult | null {
  const db = getDb()
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString()

  const row = db
    .prepare(
      `SELECT output FROM ai_activity_log
       WHERE user_id = ? AND action = 'briefing' AND status = 'success'
         AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, cutoff) as { output: string } | undefined

  if (!row?.output) return null

  try {
    const parsed = BriefingResultSchema.safeParse(JSON.parse(row.output))
    if (parsed.success) return parsed.data
  } catch {
    // Invalid cached data
  }

  return null
}

/**
 * Parse a markdown text response into a BriefingResult.
 *
 * Extracts sections from markdown headings (## Heading)
 * and items from numbered/bulleted lists.
 */
function parseTextBriefing(text: string): BriefingResult | null {
  const lines = text.split('\n').map((l) => l.trim())

  /** Strip markdown bold markers from text */
  const stripBold = (s: string) => s.replace(/\*+/g, '').trim()

  // Extract greeting: first non-empty line that isn't a heading or meta-comment.
  // Skip lines that look like the model talking about what it's going to do.
  const metaPhrases = /^(i'll|i will|let me|here's|here is|based on)/i
  let greeting = ''
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('**')) continue
    const clean = stripBold(line)
    if (metaPhrases.test(clean)) continue
    greeting = clean
    break
  }

  // Extract sections from headings: "## Heading", "### Heading", or "**Bold Heading**"
  const sections: BriefingResult['sections'] = []
  let currentSection: { heading: string; items: BriefingResult['sections'][0]['items'] } | null =
    null

  const isHeading = (line: string) =>
    line.startsWith('## ') || line.startsWith('### ') || /^\*\*[^*]+\*\*$/.test(line)
  const extractHeading = (line: string) => stripBold(line.replace(/^#+\s*/, ''))

  // Items: "- text", "* text", "1. text", or "[ ] text" (markdown checkbox)
  const isItem = (line: string) =>
    line.startsWith('- ') ||
    line.startsWith('* ') ||
    /^\d+\.\s/.test(line) ||
    line.startsWith('[ ] ') ||
    line.startsWith('[x] ')

  const extractItemText = (line: string) =>
    stripBold(
      line
        .replace(/^[-*]\s*|^\d+\.\s*/, '') // strip list prefix (- or 1.)
        .replace(/^\[[ x]\]\s*/, ''), // strip checkbox prefix ([ ] or [x])
    )

  for (const line of lines) {
    if (isHeading(line)) {
      if (currentSection && currentSection.items.length > 0) sections.push(currentSection)
      currentSection = { heading: extractHeading(line), items: [] }
    } else if (currentSection && isItem(line)) {
      const itemText = extractItemText(line)
      const taskIdMatch = itemText.match(/\[(\d+)\]/)
      currentSection.items.push({
        task_id: taskIdMatch ? parseInt(taskIdMatch[1], 10) : null,
        text: taskIdMatch ? itemText.replace(/\[\d+\]\s*/, '') : itemText,
        actionable: !!taskIdMatch,
      })
    }
  }
  if (currentSection && currentSection.items.length > 0) sections.push(currentSection)

  if (sections.length === 0) return null

  // Use a default greeting if none was found in the text
  if (!greeting) greeting = 'Here is your daily briefing.'

  return { greeting, sections, generated_at: nowUtc() }
}

/** Store briefing in activity log for cache persistence */
function cacheBriefing(userId: number, briefing: BriefingResult): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, error, created_at)
     VALUES (?, NULL, 'briefing', 'success', NULL, ?, 'cache', 0, NULL, ?)`,
  ).run(userId, JSON.stringify(briefing), nowUtc())
}
