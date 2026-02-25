/**
 * Quick Take — AI commentary on task creation
 *
 * Generates a snappy one-liner after a task is quick-added, showing awareness
 * of the user's existing tasks. Cross-references when relevant ("you've got
 * 2 other Acme tasks this week") or gives a brief useful observation.
 *
 * Designed to be fast (30s timeout, Haiku by default) and non-blocking —
 * task creation is never delayed by quick take failure.
 *
 * The prompt is structured to eliminate counting errors: code precomputes all
 * statistics (due today, due this week, by project, by label) and injects
 * them into a "Summary" block. The model reads and references these numbers
 * rather than scanning the task list itself.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape accepted by formatCompactTaskList and buildTaskStats */
export interface QuickTakeTask {
  title: string
  project_name?: string | null
  due_at?: string | null
  priority: number
  labels?: string[]
}

/** Precomputed statistics injected into the prompt so the model never counts */
export interface TaskStats {
  dueToday: number
  dueThisWeek: number
  undated: number
  byProject: Array<{ name: string; count: number }>
  byLabel: Array<{ name: string; count: number }>
}

// ---------------------------------------------------------------------------
// Task list formatting
// ---------------------------------------------------------------------------

/**
 * Build a compact one-line-per-task string from task-like objects.
 * Exported so the quality test can build the same format from scenario data.
 */
export function formatCompactTaskList(
  tasks: QuickTakeTask[],
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
    if (t.labels && t.labels.length > 0) {
      parts.push(t.labels.map((l) => `#${l}`).join(' '))
    }
    return parts.join(' ')
  })

  return { text: lines.join('\n'), count: tasks.length }
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

/**
 * Precompute statistics from the task list so the model never has to count.
 * Exported so the quality test runner can build the same stats from scenario data.
 */
export function buildTaskStats(tasks: QuickTakeTask[], timezone: string): TaskStats {
  const now = DateTime.now().setZone(timezone)
  const todayStart = now.startOf('day')
  const todayEnd = now.endOf('day')
  // Week: Monday through Sunday in the user's timezone
  const weekStart = now.startOf('week') // Luxon weeks start on Monday
  const weekEnd = now.endOf('week')

  let dueToday = 0
  let dueThisWeek = 0
  let undated = 0
  const projectCounts = new Map<string, number>()
  const labelCounts = new Map<string, number>()

  for (const t of tasks) {
    if (!t.due_at) {
      undated++
    } else {
      const due = DateTime.fromISO(t.due_at, { zone: 'utc' }).setZone(timezone)
      if (due >= todayStart && due <= todayEnd) dueToday++
      if (due >= weekStart && due <= weekEnd) dueThisWeek++
    }

    if (t.project_name) {
      projectCounts.set(t.project_name, (projectCounts.get(t.project_name) ?? 0) + 1)
    }

    if (t.labels) {
      for (const label of t.labels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
      }
    }
  }

  // Sort by count descending, take top entries
  const byProject = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }))

  const byLabel = [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }))

  return { dueToday, dueThisWeek, undated, byProject, byLabel }
}

// ---------------------------------------------------------------------------
// Production data loader
// ---------------------------------------------------------------------------

/**
 * Build a compact task list + stats from the database for the given user.
 * Production entry point — fetches tasks and resolves project names.
 */
function buildFromDb(
  userId: number,
  timezone: string,
): { text: string; count: number; stats: TaskStats } {
  const tasks = getTasks({ userId, done: false })
  if (tasks.length === 0) {
    return {
      text: '(none)',
      count: 0,
      stats: { dueToday: 0, dueThisWeek: 0, undated: 0, byProject: [], byLabel: [] },
    }
  }

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

  // Parse labels from JSON string (DB stores labels as JSON text)
  const withNames: QuickTakeTask[] = tasks.map((t) => {
    let labels: string[] = []
    if (t.labels) {
      try {
        labels = typeof t.labels === 'string' ? JSON.parse(t.labels) : t.labels
      } catch {
        labels = []
      }
    }
    return {
      title: t.title,
      project_name: projectMap.get(t.project_id) ?? null,
      due_at: t.due_at,
      priority: t.priority,
      labels,
    }
  })

  const { text, count } = formatCompactTaskList(withNames, timezone)
  const stats = buildTaskStats(withNames, timezone)

  return { text, count, stats }
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Format the summary block from precomputed stats.
 *
 * Uses one stat per line for reliable model parsing (pipe-separated lines
 * were sometimes ignored by Haiku). Example:
 *
 *   Summary:
 *   - 12 active tasks
 *   - 3 due today
 *   - 8 due this week
 *   - 1 undated
 *   - Projects: Acme Corp (3), Platform Team (2)
 *   - Labels: work (4), bug (2)
 */
function formatSummaryBlock(count: number, stats: TaskStats): string {
  const lines = [
    'Summary:',
    `- ${count} active tasks`,
    `- ${stats.dueToday} due today`,
    `- ${stats.dueThisWeek} due this week`,
    `- ${stats.undated} undated`,
  ]

  if (stats.byProject.length > 0) {
    lines.push('- Projects: ' + stats.byProject.map((p) => `${p.name} (${p.count})`).join(', '))
  }

  if (stats.byLabel.length > 0) {
    lines.push('- Labels: ' + stats.byLabel.map((l) => `${l.name} (${l.count})`).join(', '))
  }

  return lines.join('\n')
}

/**
 * Format the new task line, describing what metadata the new task has/lacks.
 *
 * Quick take runs before enrichment, so new tasks typically have no due date,
 * priority, or project. The model needs to know this so it can correctly
 * observe "no due date set" rather than guessing.
 */
function formatNewTaskLine(newTaskTitle: string, newTaskHasDueDate: boolean): string {
  const meta = newTaskHasDueDate
    ? 'has a due date — not counted in summary'
    : 'no due date, no priority, no project — not counted in summary'
  return `New task: "${newTaskTitle}" (${meta})`
}

/**
 * Compute the most notable pattern from precomputed stats.
 *
 * Returns a short string highlighting the most interesting fact — a packed
 * day, a loaded week, a dominant project, etc. The model reads this as a
 * clear signal about what's worth mentioning, eliminating reliance on the
 * model's own scanning of the summary block.
 *
 * Returns null when the task list is too small for anything to stand out.
 */
function computeNotablePattern(count: number, stats: TaskStats): string | null {
  if (count === 0) return 'The task list is empty — this is the first task.'
  if (stats.dueToday >= 4) return `Packed day: ${stats.dueToday} tasks already due today.`
  if (stats.dueThisWeek >= 10) return `Full week: ${stats.dueThisWeek} tasks due this week.`
  if (stats.byProject.length > 0 && stats.byProject[0].count >= 3) {
    const top = stats.byProject[0]
    return `Active project: ${top.name} has ${top.count} tasks.`
  }
  if (stats.undated >= 3) return `${stats.undated} tasks sitting in the inbox without dates.`
  return null
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
  stats?: TaskStats,
  newTaskHasDueDate?: boolean,
): string {
  const currentTime = DateTime.now().setZone(timezone).toFormat('ccc, LLL d, h:mm a')

  // Build summary block from stats if provided, otherwise a simple count
  const summaryBlock = stats
    ? `\n${formatSummaryBlock(count, stats)}\n`
    : `\nSummary:\n- ${count} active tasks\n`

  const newTaskLine = formatNewTaskLine(newTaskTitle, newTaskHasDueDate ?? false)
  const notablePattern = stats ? computeNotablePattern(count, stats) : null
  const notableLine = notablePattern ? `\nNotable: ${notablePattern}\n` : ''

  // -------------------------------------------------------------------
  // Prompt structure:
  //   1. Role + scene (what the model is reading, what it produces)
  //   2. OpenTask context (just enough to make the data legible)
  //   3. Examples (carry the teaching load)
  //   4. Conventions (word limit, output format, stats usage)
  //   5. Data block (notable pattern, summary stats, new task, task list)
  //   6. Closing block (reinforcement at recency peak)
  // -------------------------------------------------------------------

  return `The user just added a task to OpenTask. You will see their full task list with precomputed summary stats. Write one sentence noting how the new task fits the picture — a pattern, a cluster, or something that stands out.

OpenTask context: Tasks are organized by project. Tasks without a due date sit in the user's inbox until scheduled. The new task was just created via quick-add, so it typically has only a title — no due date, priority, or project yet (unless explicitly set, which is noted below).

Examples:
- "3 Acme tasks already on the board this week, and now a 4th."
- "your Tuesday is stacking up — 5 due today."
- "15 tasks due this week — adding one more to the pile."
- "joining 2 other undated tasks in your inbox."
- "that's your only non-work task on the list right now."
- "the bug backlog grows — 7 undated fixes in Website Redesign now."
- "first task on the list — starting fresh."

The Summary numbers are exact — use them, do not count the task list. Only state facts in the data. Max 20 words. No quotes.

Current time: ${currentTime} (${timezone})
${notableLine}${summaryBlock}${newTaskLine}

Existing tasks:
${compactTaskList}

ONE sentence. Use the Summary numbers above — observe, never advise.`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a quick take — a one-liner showing awareness of the user's task list.
 * Returns null if AI is disabled, the call fails, or times out.
 */
export async function generateQuickTake(
  userId: number,
  timezone: string,
  newTaskTitle: string,
  newTaskHasDueDate: boolean = false,
): Promise<string | null> {
  if (!isAIEnabled()) return null

  try {
    const { text: compactTaskList, count, stats } = buildFromDb(userId, timezone)
    const prompt = buildQuickTakePrompt(
      compactTaskList,
      count,
      timezone,
      newTaskTitle,
      stats,
      newTaskHasDueDate,
    )

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
