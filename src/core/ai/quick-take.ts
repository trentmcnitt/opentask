/**
 * Quick Take — AI commentary on task creation
 *
 * Generates a snappy one-liner after a task is quick-added, showing awareness
 * of the user's existing tasks. Cross-references when relevant ("you've got
 * 2 other Acme tasks this week") or gives a brief useful observation.
 *
 * Designed to be fast (30s timeout, Haiku by default) and non-blocking —
 * task creation is never delayed by quick take failure.
 */

import { DateTime } from 'luxon'
import { getTasks } from '@/core/tasks'
import { getDb } from '@/core/db'
import { isAIEnabled, aiQuery } from './sdk'
import { log } from '@/lib/logger'

const PRIORITY_LABELS: Record<number, string> = {
  0: '',
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'P4',
}

/** Max tasks to include in the prompt context */
const MAX_TASKS = 150

/**
 * Build a compact one-line-per-task string from task-like objects.
 * Exported so the quality test can build the same format from scenario data.
 */
export function formatCompactTaskList(
  tasks: Array<{
    title: string
    project_name?: string | null
    due_at?: string | null
    priority: number
  }>,
  timezone: string,
): { text: string; count: number } {
  if (tasks.length === 0) return { text: '(none)', count: 0 }

  const now = DateTime.now().setZone(timezone)
  const capped = tasks.slice(0, MAX_TASKS)

  const lines = capped.map((t) => {
    const parts: string[] = [`- "${t.title}"`]
    if (t.project_name) parts.push(`[${t.project_name}]`)
    if (t.due_at) {
      const due = DateTime.fromISO(t.due_at, { zone: 'utc' }).setZone(timezone)
      parts.push(`due:${formatCompactDate(due, now)}`)
    }
    const pLabel = PRIORITY_LABELS[t.priority]
    if (pLabel) parts.push(pLabel)
    return parts.join(' ')
  })

  return { text: lines.join('\n'), count: tasks.length }
}

/**
 * Build a compact task list from the database for the given user.
 * Production entry point — fetches tasks and resolves project names.
 */
function buildCompactTaskListFromDb(
  userId: number,
  timezone: string,
): { text: string; count: number } {
  const tasks = getTasks({ userId, done: false })
  if (tasks.length === 0) return { text: '(none)', count: 0 }

  // Bulk project name lookup (same pattern as buildTaskSummaries)
  const db = getDb()
  const projectIds = [...new Set(tasks.map((t) => t.project_id))]
  const projectMap = new Map<number, string>()

  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, name FROM projects WHERE id IN (${placeholders})`)
      .all(...projectIds) as { id: number; name: string }[]
    for (const row of rows) {
      projectMap.set(row.id, row.name)
    }
  }

  const withNames = tasks.map((t) => ({
    title: t.title,
    project_name: projectMap.get(t.project_id) ?? null,
    due_at: t.due_at,
    priority: t.priority,
  }))

  return formatCompactTaskList(withNames, timezone)
}

/**
 * Format a date compactly for the task list: "Today", "Tomorrow", "Wed", "Feb 15"
 */
function formatCompactDate(dt: DateTime, now: DateTime): string {
  const diffDays = Math.floor(dt.startOf('day').diff(now.startOf('day'), 'days').days)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays > 1 && diffDays <= 6) return dt.toFormat('ccc') // "Wed"
  return dt.toFormat('LLL d') // "Feb 15"
}

/**
 * Build the quick take prompt string.
 *
 * Exported so the quality test runner can use the exact same prompt
 * as production without duplicating the template.
 */
export function buildQuickTakePrompt(
  compactTaskList: string,
  count: number,
  timezone: string,
  newTaskTitle: string,
): string {
  const currentTime = DateTime.now().setZone(timezone).toFormat('ccc, LLL d, h:mm a')

  return `You are a quick-response assistant for a task manager. The user just added a new task.
Write ONE short sentence (max 20 words) as a snappy acknowledgment that shows
awareness of their existing tasks.

Cross-reference when relevant: "you've got 2 other Acme tasks this week",
"your Tuesday is filling up — this makes 4". If nothing interesting to
cross-reference, give a brief useful observation: "no due date set, it'll
sit in your inbox" or "that's your only errand today".

Do NOT be generic. Do NOT suggest prioritization. Just one sentence that shows
you see the full picture. Return ONLY the sentence, no quotes or preamble.

Current time: ${currentTime} (${timezone})
New task: "${newTaskTitle}"

Existing tasks (${count} active):
${compactTaskList}`
}

/**
 * Generate a quick take — a one-liner showing awareness of the user's task list.
 * Returns null if AI is disabled, the call fails, or times out.
 */
export async function generateQuickTake(
  userId: number,
  timezone: string,
  newTaskTitle: string,
): Promise<string | null> {
  if (!isAIEnabled()) return null

  try {
    const { text: compactTaskList, count } = buildCompactTaskListFromDb(userId, timezone)
    const prompt = buildQuickTakePrompt(compactTaskList, count, timezone, newTaskTitle)

    const model = process.env.OPENTASK_AI_QUICKTAKE_MODEL || 'haiku'

    const result = await aiQuery({
      prompt,
      model,
      maxTurns: 1,
      timeoutMs: 30000,
      userId,
      action: 'quick_take',
      inputText: newTaskTitle,
    })

    if (!result.success || !result.textResult) {
      log.warn('ai', `quick_take returned no result for "${newTaskTitle}"`)
      return null
    }

    // Strip surrounding quotes if present
    let text = result.textResult.trim()
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      text = text.slice(1, -1).trim()
    }

    return text || null
  } catch (err) {
    log.warn('ai', 'quick_take generation failed:', err)
    return null
  }
}
