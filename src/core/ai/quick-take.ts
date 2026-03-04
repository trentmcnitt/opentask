/**
 * Quick Take — AI commentary on task creation
 *
 * Generates a snappy one-liner after a task is quick-added, showing awareness
 * of the user's existing tasks. Cross-references when relevant ("you've got
 * 2 other Acme tasks this week") or gives a brief useful observation.
 *
 * Uses a warm subprocess slot (quick-take-slot.ts) for low latency, falling
 * back to the cold aiQuery() path if the slot is unavailable.
 *
 * The prompt is split into a static system prompt (loaded once at slot init)
 * and a dynamic user prompt (pushed per request). buildQuickTakePrompt()
 * combines both for testing and dump-prompts.
 *
 * The prompt is structured to eliminate counting errors: code precomputes all
 * statistics (due today, due this week, by project, by label) and injects
 * them into a "Summary" block. The model reads and references these numbers
 * rather than scanning the task list itself.
 */

import { DateTime } from 'luxon'
import { getTasks } from '@/core/tasks'
import { getProjectNameMap } from '@/core/projects'
import { isAIEnabled, aiQuery } from './sdk'
import { quickTakeSlotQuery } from './quick-take-slot'
import { resolveFeatureAIConfig } from './models'
import { getUserFeatureModes } from './user-context'
import { log } from '@/lib/logger'

const PRIORITY_LABELS: Record<number, string> = {
  0: '',
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'P4',
}

/**
 * Max tasks to include in the prompt's "Existing tasks:" list. Stats are computed
 * from ALL tasks before capping, so the model has accurate counts regardless.
 * Tasks are sorted by relevance (dated first, then recent undated) before capping.
 */
const MAX_TASKS = 60

// ---------------------------------------------------------------------------
// System prompt (static, loaded once at slot init)
// ---------------------------------------------------------------------------

/**
 * Static system prompt for the quick take warm slot.
 * Contains role, examples, and constraints — everything that doesn't change
 * between requests. The dynamic data (stats, task list, new task) goes in
 * the user prompt built by buildQuickTakeUserPrompt().
 */
export const QUICK_TAKE_SYSTEM_PROMPT = `You are the AI in OpenTask, a task management app. The user just quick-added a task. Write one sentence about what's notable in context — a pattern, a contrast, a crowded day, an outlier. Report what the data shows. A boring truth always beats a clever falsehood.

**Best angles** (prefer these):
- Timing: a packed day, a stacked week, an empty calendar
- Content: similar tasks clustering, a theme emerging, a recurring topic
- Contrast: personal among work tasks, a one-off among routines, a different gear

**Avoid:**
- Counting small lists. For under 10 tasks, project/label counts are not notable — "Inbox has 2 tasks" is never interesting. Focus on what the task IS, not where it lands.
- Stat recitation. "N tasks in project X" is only interesting when N is genuinely large (10+) or represents a surprising concentration.

Examples:
- "Tuesday's getting crowded — 5 things and counting."
- "first task on an empty board."
- "another fix for Website Redesign — the bug backlog grows."
- "this one's a one-off among your daily routines."
- "Friday is already stacked: a deploy, happy hour, and now slides."
- "a personal errand slipping in among the sprint work."

The Summary stats are precomputed and exact — use them instead of counting the task list. Never claim "only" or "first" unless the stats confirm it. Most new tasks have no due date — that's the default, not noteworthy.

Max 25 words. No quotes. Observe, never advise. Vary your angle.`

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
  rrule?: string | null
}

/** Precomputed statistics injected into the prompt so the model never counts */
export interface TaskStats {
  dueToday: number
  dueThisWeek: number
  undated: number
  recurring: number
  noProject: number
  byProject: Array<{ name: string; count: number }>
  byLabel: Array<{ name: string; count: number }>
  /** Busiest day this week — which day has the most tasks. Null when no tasks due this week. */
  busiestDay: { dayName: string; count: number } | null
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
  let recurring = 0
  let noProject = 0
  const projectCounts = new Map<string, number>()
  const labelCounts = new Map<string, number>()
  // Track per-day counts for busiest day computation
  const dayCounts = new Map<string, number>()

  for (const t of tasks) {
    if (!t.due_at) {
      undated++
    } else {
      const due = DateTime.fromISO(t.due_at, { zone: 'utc' }).setZone(timezone)
      if (due >= todayStart && due <= todayEnd) dueToday++
      if (due >= weekStart && due <= weekEnd) {
        dueThisWeek++
        // Track day-level counts for busiest day
        const dayKey = due.toFormat('ccc') // "Mon", "Tue", etc.
        dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1)
      }
    }

    if (t.rrule) recurring++
    if (!t.project_name) noProject++

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

  // Find busiest day this week (only meaningful when there are tasks due this week)
  let busiestDay: { dayName: string; count: number } | null = null
  if (dayCounts.size > 0) {
    let maxDay = ''
    let maxCount = 0
    for (const [day, count] of dayCounts) {
      if (count > maxCount) {
        maxDay = day
        maxCount = count
      }
    }
    if (maxCount >= 2) busiestDay = { dayName: maxDay, count: maxCount }
  }

  return {
    dueToday,
    dueThisWeek,
    undated,
    recurring,
    noProject,
    byProject,
    byLabel,
    busiestDay,
  }
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
): { text: string; count: number; stats: TaskStats; tasks: QuickTakeTask[] } {
  const tasks = getTasks({ userId, done: false })
  if (tasks.length === 0) {
    return {
      text: '(none)',
      count: 0,
      stats: {
        dueToday: 0,
        dueThisWeek: 0,
        undated: 0,
        recurring: 0,
        noProject: 0,
        byProject: [],
        byLabel: [],
        busiestDay: null,
      },
      tasks: [],
    }
  }

  // Bulk project name lookup
  const projectIds = [...new Set(tasks.map((t) => t.project_id))]
  const projectMap = getProjectNameMap(projectIds)

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
      rrule: t.rrule ?? null,
    }
  })

  // No sorting before capping — DB returns tasks in creation order (newest last).
  // The previous due-date-first sort biased the capped sample toward projects
  // with more dated tasks, giving the model a skewed view of list composition.
  // The summary stats (computed from ALL tasks) provide accurate aggregate counts;
  // the task list just needs to be a representative sample.

  // Stats are computed from ALL tasks (before capping) — model gets accurate counts.
  const stats = buildTaskStats(withNames, timezone)
  const { text, count } = formatCompactTaskList(withNames, timezone)

  return { text, count, stats, tasks: withNames }
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
    `- ${count} active tasks (${stats.recurring} recurring, ${count - stats.recurring} one-off)`,
    `- ${stats.dueToday} due today`,
    `- ${stats.dueThisWeek} due this week`,
  ]

  // Busiest day — helps the model see day-level density in packed weeks
  if (stats.busiestDay) {
    lines.push(`- Busiest day: ${stats.busiestDay.dayName} (${stats.busiestDay.count} tasks)`)
  }

  // Clarify undated count — explicitly say "all have due dates" when 0 to prevent
  // the model from confusing the new task's "no due date" with existing tasks
  if (stats.undated === 0 && count > 0) {
    lines.push('- 0 undated (all existing tasks have due dates)')
  } else {
    lines.push(`- ${stats.undated} undated`)
  }

  if (stats.byProject.length > 0) {
    lines.push('- Projects: ' + stats.byProject.map((p) => `${p.name} (${p.count})`).join(', '))
  }
  if (stats.noProject > 0 && stats.byProject.length > 0) {
    lines.push(`- ${stats.noProject} with no project`)
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
  if (stats.dueThisWeek >= 10) {
    const dayNote = stats.busiestDay
      ? ` Busiest: ${stats.busiestDay.dayName} (${stats.busiestDay.count}).`
      : ''
    return `Full week: ${stats.dueThisWeek} tasks due this week.${dayNote}`
  }
  if (stats.byProject.length > 0 && stats.byProject[0].count >= 3) {
    const top = stats.byProject[0]
    return `Active project: ${top.name} has ${top.count} tasks.`
  }
  if (stats.undated >= 3) return `${stats.undated} tasks sitting in the inbox without dates.`
  return null
}

/**
 * Detect relationships between the new task and existing tasks algorithmically.
 *
 * Returns a short context line the model can reference instead of scanning the
 * task list itself. Examples:
 *   - "New task title matches project 'Acme Corp' (3 tasks)"
 *   - "New task shares 'Fix...' pattern with 6 existing tasks"
 *   - "All 6 existing tasks are work-related — new task is different"
 *   - null (no obvious relationship detected)
 */
function computeNewTaskContext(
  newTaskTitle: string,
  tasks: QuickTakeTask[],
  stats: TaskStats,
): string | null {
  if (tasks.length === 0) return null

  const titleLower = newTaskTitle.toLowerCase()

  // 1. Does the new task title contain a project name (or a significant word from it)?
  for (const p of stats.byProject) {
    const projectLower = p.name.toLowerCase()
    // Check full name first, then individual significant words (length > 2)
    if (titleLower.includes(projectLower)) {
      return `New task title matches project "${p.name}" (${p.count} existing tasks).`
    }
    const projectWords = projectLower.split(/\s+/).filter((w) => w.length > 2)
    for (const word of projectWords) {
      if (titleLower.includes(word)) {
        return `New task title matches project "${p.name}" (${p.count} existing tasks).`
      }
    }
  }

  // 2. Does the new task share a common title prefix with multiple tasks?
  // Get the first significant word of the new task (skip common articles)
  const skipWords = new Set(['a', 'an', 'the', 'my', 'our', 'this', 'that'])
  const newWords = titleLower.split(/\s+/).filter((w) => !skipWords.has(w))
  if (newWords.length > 0) {
    const firstWord = newWords[0]
    // Count how many existing tasks start with the same word
    const matching = tasks.filter((t) => {
      const tWords = t.title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => !skipWords.has(w))
      return tWords.length > 0 && tWords[0] === firstWord
    })
    if (matching.length >= 3) {
      const capitalFirst = firstWord.charAt(0).toUpperCase() + firstWord.slice(1)
      return `New task shares "${capitalFirst}..." pattern with ${matching.length} existing tasks.`
    }
  }

  // 3. Does one project/label dominate and the new task is different?
  //    Combine both signals when they co-occur so the model gets the full picture.
  const dominantProject =
    stats.byProject.length >= 1 &&
    stats.byProject[0].count >= tasks.length * 0.7 &&
    !titleLower.includes(stats.byProject[0].name.toLowerCase())
      ? stats.byProject[0]
      : null
  const dominantLabel =
    stats.byLabel.length > 0 &&
    stats.byLabel[0].count >= tasks.length * 0.7 &&
    !titleLower.includes(stats.byLabel[0].name.toLowerCase())
      ? stats.byLabel[0]
      : null

  if (dominantProject && dominantLabel) {
    return `${dominantProject.count} of ${tasks.length} tasks are "${dominantProject.name}" / #${dominantLabel.name} — new task is the only one outside that pattern.`
  }
  if (dominantProject) {
    return `${dominantProject.count} of ${tasks.length} tasks are in "${dominantProject.name}" — new task is the only one outside that project.`
  }
  if (dominantLabel) {
    return `${dominantLabel.count} of ${tasks.length} tasks are #${dominantLabel.name} — new task is the only non-${dominantLabel.name} task.`
  }

  return null
}

/**
 * Build just the user/dynamic portion of the quick take prompt.
 *
 * This is what gets pushed to the warm slot per request. The system prompt
 * (role, examples, constraints) is already loaded in the subprocess.
 */
export function buildQuickTakeUserPrompt(
  compactTaskList: string,
  count: number,
  timezone: string,
  newTaskTitle: string,
  stats?: TaskStats,
  newTaskHasDueDate?: boolean,
  tasks?: QuickTakeTask[],
): string {
  const currentTime = DateTime.now().setZone(timezone).toFormat('ccc, LLL d, h:mm a')

  const summaryBlock = stats
    ? `\n${formatSummaryBlock(count, stats)}\n`
    : `\nSummary:\n- ${count} active tasks\n`

  const newTaskLine = formatNewTaskLine(newTaskTitle, newTaskHasDueDate ?? false)
  const notablePattern = stats ? computeNotablePattern(count, stats) : null
  const notableLine = notablePattern ? `\nNotable: ${notablePattern}\n` : ''

  const contextLine = stats && tasks ? computeNewTaskContext(newTaskTitle, tasks, stats) : null
  const contextBlock = contextLine ? `Context: ${contextLine}\n` : ''

  return `Current time: ${currentTime} (${timezone})
${notableLine}${summaryBlock}${contextBlock}${newTaskLine}

Existing tasks:
${compactTaskList}

ONE sentence, max 25 words. Only state what the Summary confirms.`
}

/**
 * Build the full quick take prompt string (system + user combined).
 *
 * Exported so the quality test runner and dump-prompts can use the exact
 * same prompt as production without duplicating the template.
 *
 * Composes QUICK_TAKE_SYSTEM_PROMPT + buildQuickTakeUserPrompt() to avoid
 * duplicating the prompt text. The warm slot loads these separately; the cold
 * path and test tooling use this combined version.
 */
export function buildQuickTakePrompt(
  compactTaskList: string,
  count: number,
  timezone: string,
  newTaskTitle: string,
  stats?: TaskStats,
  newTaskHasDueDate?: boolean,
  tasks?: QuickTakeTask[],
): string {
  const userPrompt = buildQuickTakeUserPrompt(
    compactTaskList,
    count,
    timezone,
    newTaskTitle,
    stats,
    newTaskHasDueDate,
    tasks,
  )
  return `${QUICK_TAKE_SYSTEM_PROMPT}\n\n${userPrompt}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip surrounding quotes from model output.
 * Despite "No quotes" in the prompt, models occasionally wrap output in quotes.
 */
function stripQuotes(text: string): string {
  let stripped = text.trim()
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    stripped = stripped.slice(1, -1).trim()
  }
  return stripped
}

/**
 * Generate a quick take — a one-liner showing awareness of the user's task list.
 *
 * Tries the warm slot first for low latency (~2-3s). Falls back to the cold
 * aiQuery() path if the slot is unavailable (dead, uninitialized, initializing).
 *
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
    const modes = getUserFeatureModes(userId)
    if (modes.quick_take === 'off') return null

    const { text: compactTaskList, count, stats, tasks } = buildFromDb(userId, timezone)
    const config = resolveFeatureAIConfig('quick_take', modes.quick_take)
    const { provider, model } = config

    // SDK mode: try warm slot first for low latency
    if (modes.quick_take === 'sdk') {
      const userPrompt = buildQuickTakeUserPrompt(
        compactTaskList,
        count,
        timezone,
        newTaskTitle,
        stats,
        newTaskHasDueDate,
        tasks,
      )

      const slotResult = await quickTakeSlotQuery(userPrompt, {
        userId,
        inputText: newTaskTitle,
      })

      if (slotResult !== null) {
        // Warm slot handled the request (even if text is null from superseding)
        if (!slotResult.text) return null
        return stripQuotes(slotResult.text) || null
      }

      // Warm slot unavailable — fall through to cold path
      log.debug('ai', 'Quick Take: warm slot unavailable, using cold path')
    }

    // Cold path: direct API call (used by non-SDK providers and SDK fallback)
    const prompt = buildQuickTakePrompt(
      compactTaskList,
      count,
      timezone,
      newTaskTitle,
      stats,
      newTaskHasDueDate,
      tasks,
    )

    const result = await aiQuery({
      prompt,
      model,
      maxTurns: 1,
      timeoutMs: 40000,
      userId,
      action: 'quick_take',
      inputText: newTaskTitle,
      provider,
      providerConfig: config.providerConfig,
    })

    if (!result.success || !result.textResult) {
      log.warn('ai', `quick_take returned no result for "${newTaskTitle}"`)
      return null
    }

    return stripQuotes(result.textResult) || null
  } catch (err) {
    log.warn('ai', 'quick_take generation failed:', err)
    return null
  }
}
