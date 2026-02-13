/**
 * AI Insights — batch task scoring, commentary, and signal detection
 *
 * Processes the user's entire task list in batches, scoring each task 0-100
 * based on how much it needs attention, adding one-line commentary, and
 * optionally tagging tasks with signals from a preset vocabulary.
 *
 * Results are cached in `ai_insights_results` for fast retrieval.
 * Generation progress is tracked in `ai_insights_sessions` for polling.
 */

import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse, extractJsonFromText } from './parse-helpers'
import { INSIGHTS_SYSTEM_PROMPT, INSIGHTS_REMINDERS } from './prompts'
import { formatTaskLine, getScheduleBlock } from './format'
import { InsightsBatchResultSchema } from './types'
import type { InsightsItem, InsightsSignalKey, TaskSummary } from './types'
import { log } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Signal vocabulary — display properties for UI rendering
// ---------------------------------------------------------------------------

export interface InsightsSignal {
  key: InsightsSignalKey
  label: string
  /** Tailwind color class prefix (e.g., 'indigo' → use bg-indigo-100, text-indigo-700) */
  color: string
  /** Lucide icon name */
  icon: string
  description: string
}

export const INSIGHTS_SIGNALS: InsightsSignal[] = [
  {
    key: 'review',
    label: 'Review',
    color: 'indigo',
    icon: 'Eye',
    description: 'Worth a closer look',
  },
  {
    key: 'stale',
    label: 'Stale',
    color: 'gray',
    icon: 'Clock',
    description: 'Sitting for weeks, might not be relevant',
  },
  {
    key: 'act_soon',
    label: 'Act Soon',
    color: 'amber',
    icon: 'AlertTriangle',
    description: 'Window closing, time-sensitive',
  },
  {
    key: 'quick_win',
    label: 'Quick Win',
    color: 'green',
    icon: 'Zap',
    description: 'Small task, easy to knock out',
  },
  {
    key: 'vague',
    label: 'Vague',
    color: 'blue',
    icon: 'HelpCircle',
    description: 'Unclear what this requires',
  },
  {
    key: 'misprioritized',
    label: 'Misprioritized',
    color: 'purple',
    icon: 'ArrowUpDown',
    description: 'Priority seems off for what this is',
  },
]

export const SIGNAL_MAP = new Map(INSIGHTS_SIGNALS.map((s) => [s.key, s]))

// ---------------------------------------------------------------------------
// Insights session types
// ---------------------------------------------------------------------------

export interface InsightsSession {
  id: string
  user_id: number
  status: 'running' | 'complete' | 'failed'
  total_tasks: number
  completed: number
  started_at: string
  finished_at: string | null
  error: string | null
}

export interface InsightsResult {
  task_id: number
  score: number
  commentary: string
  signals: InsightsSignalKey[]
  generated_at: string
}

// ---------------------------------------------------------------------------
// Signal sanitization — defense-in-depth for prompt compliance
//
// The prompt instructs the AI to follow these rules, but Haiku sometimes
// ignores them when the task context feels urgent. We enforce them in code
// to guarantee no invalid signals reach the user.
// ---------------------------------------------------------------------------

const STALE_MIN_AGE_DAYS = 21
const ACT_SOON_MIN_PRIORITY = 3
/** Score ceiling for P4 tasks — they're already visible, don't inflate. */
const P4_SCORE_CEILING = 25

/**
 * Enforce hard rules that the AI sometimes ignores:
 * - P4 score ceiling: clamp P4 task scores to 25 (user already sees these)
 * - act_soon requires P3+ (never P0-2)
 * - stale requires 21+ days old
 */
export function sanitizeSignals(items: InsightsItem[], taskMap: Map<number, TaskSummary>): void {
  for (const item of items) {
    const task = taskMap.get(item.task_id)
    if (!task) continue

    // P4 score clamping: these tasks are already demanding attention
    if (task.priority === 4 && item.score > P4_SCORE_CEILING) {
      log.debug(
        'ai',
        `Clamped P4 task ${item.task_id} score from ${item.score} to ${P4_SCORE_CEILING}`,
      )
      item.score = P4_SCORE_CEILING
    }

    if (item.signals.length === 0) continue

    const original = item.signals.length
    item.signals = item.signals.filter((signal) => {
      if (signal === 'act_soon' && task.priority < ACT_SOON_MIN_PRIORITY) return false
      if (signal === 'stale') {
        const ageMs = Date.now() - new Date(task.created_at).getTime()
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
        if (ageDays < STALE_MIN_AGE_DAYS) return false
      }
      return true
    })

    if (item.signals.length < original) {
      log.debug(
        'ai',
        `Stripped invalid signals from task ${item.task_id} (had ${original}, kept ${item.signals.length})`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk processing
// ---------------------------------------------------------------------------

/**
 * Maximum number of tasks per AI call. Lists up to this size are sent in a
 * single call; larger lists are shuffled and split into equal chunks.
 */
const SINGLE_CALL_THRESHOLD = 500

/** Timeout for insights AI calls (5 minutes) to accommodate large task lists. */
const INSIGHTS_TIMEOUT_MS = 300_000

/**
 * Fisher-Yates shuffle — returns a new array in random order.
 */
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/**
 * Build a calibration summary of the full task list for overflow chunks.
 * Gives each chunk context about the overall list composition so the LLM
 * can score its subset relative to the whole.
 */
function buildTaskListSummary(tasks: TaskSummary[], now: DateTime): string {
  // Priority distribution
  const pCounts = [0, 0, 0, 0, 0]
  for (const t of tasks) pCounts[t.priority]++
  const priorityLine = pCounts
    .map((count, i) =>
      count > 0 ? `P${i}: ${count} (${Math.round((count / tasks.length) * 100)}%)` : null,
    )
    .filter(Boolean)
    .join(', ')

  // Project breakdown (sorted by count descending)
  const projectCounts = new Map<string, number>()
  for (const t of tasks) {
    const name = t.project_name || 'Inbox'
    projectCounts.set(name, (projectCounts.get(name) || 0) + 1)
  }
  const projectLine = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`)
    .join(', ')

  // Age histogram
  const ageBuckets: Record<string, number> = {
    '<1 week': 0,
    '1-4 weeks': 0,
    '1-3 months': 0,
    '3+ months': 0,
  }
  for (const t of tasks) {
    const days = Math.floor(now.diff(DateTime.fromISO(t.created_at, { zone: 'utc' }), 'days').days)
    if (days < 7) ageBuckets['<1 week']++
    else if (days < 28) ageBuckets['1-4 weeks']++
    else if (days < 90) ageBuckets['1-3 months']++
    else ageBuckets['3+ months']++
  }
  const ageLine = Object.entries(ageBuckets)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`)
    .join(', ')

  return [
    '## Full task list summary (you are scoring a random subset)',
    `Total tasks: ${tasks.length}`,
    `Priority distribution: ${priorityLine}`,
    `Project breakdown: ${projectLine}`,
    `Age: ${ageLine}`,
  ].join('\n')
}

/**
 * Generate insights for a single user and await completion.
 *
 * Unlike startInsightsGeneration (fire-and-forget), this awaits processInsightsChunks
 * directly so the caller blocks until results are cached. Used by the nightly cron
 * to process users sequentially.
 */
export async function generateInsightsForUser(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
): Promise<void> {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()

  db.prepare(
    `INSERT INTO ai_insights_sessions (id, user_id, status, total_tasks, completed, started_at)
     VALUES (?, ?, 'running', ?, 0, ?)`,
  ).run(sessionId, userId, tasks.length, now)

  try {
    await processInsightsChunks(sessionId, userId, timezone, tasks, userContext, source)
  } catch (err) {
    log.error('ai', 'Insights generation failed:', err)
    db.prepare(
      `UPDATE ai_insights_sessions SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(String(err), nowUtc(), sessionId)
    throw err
  }
}

/**
 * Start an insights generation session and process tasks in background.
 *
 * Returns the session ID immediately. The caller polls getInsightsSessionStatus()
 * to track progress.
 */
export function startInsightsGeneration(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
): { sessionId: string; totalTasks: number; singleCall: boolean } {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()
  const singleCall = tasks.length <= SINGLE_CALL_THRESHOLD

  // Create session
  db.prepare(
    `INSERT INTO ai_insights_sessions (id, user_id, status, total_tasks, completed, started_at)
     VALUES (?, ?, 'running', ?, 0, ?)`,
  ).run(sessionId, userId, tasks.length, now)

  // Start processing in background (fire-and-forget)
  processInsightsChunks(sessionId, userId, timezone, tasks, userContext, source).catch((err) => {
    log.error('ai', 'Insights generation failed:', err)
    db.prepare(
      `UPDATE ai_insights_sessions SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(String(err), nowUtc(), sessionId)
  })

  return { sessionId, totalTasks: tasks.length, singleCall }
}

/**
 * Process tasks through the AI — single call for ≤500 tasks, chunked for larger lists.
 *
 * For lists over SINGLE_CALL_THRESHOLD, tasks are randomly shuffled and split into
 * equal-sized chunks. Each chunk's prompt includes a calibration summary of the full
 * list so the LLM can score relative to the whole.
 */
async function processInsightsChunks(
  sessionId: string,
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
): Promise<void> {
  const db = getDb()
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const jsonSchema = z.toJSONSchema(InsightsBatchResultSchema)
  const userContextBlock = userContext ? `\nUser context: ${userContext}\n` : ''

  const scheduleBlock = getScheduleBlock(userId)

  const sourceBlock = source === 'scheduled' ? '\nThis is an automated insights run.\n' : ''

  // Build chunks: single call for small lists, shuffled equal chunks for large ones
  let chunks: TaskSummary[][]
  let summaryHeader: string | null = null

  if (tasks.length <= SINGLE_CALL_THRESHOLD) {
    chunks = [tasks]
  } else {
    const shuffled = shuffleArray(tasks)
    const chunkCount = Math.ceil(tasks.length / SINGLE_CALL_THRESHOLD)
    const chunkSize = Math.ceil(tasks.length / chunkCount)
    chunks = []
    for (let i = 0; i < shuffled.length; i += chunkSize) {
      chunks.push(shuffled.slice(i, i + chunkSize))
    }
    summaryHeader = buildTaskListSummary(tasks, now)
  }

  let processedCount = 0

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const taskLines = chunk.map((t) => formatTaskLine(t, timezone, now)).join('\n')
    const taskIds = new Set(chunk.map((t) => t.id))
    const taskMap = new Map(chunk.map((t) => [t.id, t]))

    // Context block differs between single-call and chunked modes
    const contextBlock =
      chunks.length === 1
        ? `Total tasks: ${tasks.length}`
        : `Total tasks in full list: ${tasks.length}\nTasks in this subset: ${chunk.length} (random sample — see summary above)`

    const summaryBlock = summaryHeader ? `\n${summaryHeader}\n` : ''

    const prompt = `${INSIGHTS_SYSTEM_PROMPT}
${summaryBlock}
## Context

Current time: ${currentTime}
${contextBlock}${scheduleBlock}${sourceBlock}${userContextBlock}
<tasks>
${taskLines}
</tasks>

${INSIGHTS_REMINDERS}
Current time: ${currentTime}
Score every task above. Return a JSON array with one entry per task.`

    const inputLabel =
      chunks.length === 1
        ? `${tasks.length} tasks`
        : `chunk ${ci + 1}/${chunks.length} (${chunk.length} tasks)`

    try {
      const insightsModel = process.env.OPENTASK_AI_INSIGHTS_MODEL || 'claude-opus-4-6'
      const result = await aiQuery({
        prompt,
        outputSchema: jsonSchema,
        model: insightsModel,
        maxTurns: 1,
        // Enable extended thinking for Opus models to improve scoring quality
        ...(insightsModel.includes('opus') && { maxThinkingTokens: 10000 }),
        userId,
        action: 'insights',
        inputText: inputLabel,
        timeoutMs: INSIGHTS_TIMEOUT_MS,
      })

      const parsed = parseAIResponse(result, InsightsBatchResultSchema, 'Insights', (text) => {
        const json = extractJsonFromText(text)
        if (!json) return null

        // Handle both direct array and { tasks: [...] } wrapper
        const arr = Array.isArray(json) ? json : json.tasks
        if (!Array.isArray(arr)) return null

        const attempt = InsightsBatchResultSchema.safeParse(arr)
        return attempt.success ? attempt.data : null
      })

      if (parsed) {
        const validItems = parsed.filter((item) => taskIds.has(item.task_id))
        sanitizeSignals(validItems, taskMap)
        storeInsightsResults(userId, validItems)
        processedCount += chunk.length
      } else {
        log.warn('ai', `Insights chunk ${ci + 1} failed to parse — skipping ${chunk.length} tasks`)
        processedCount += chunk.length
      }
    } catch (err) {
      log.error('ai', `Insights chunk ${ci + 1} error:`, err)
      processedCount += chunk.length
    }

    // Update session progress
    db.prepare('UPDATE ai_insights_sessions SET completed = ? WHERE id = ?').run(
      processedCount,
      sessionId,
    )
  }

  // Mark session complete. The AND status = 'running' guard ensures cleanup only
  // runs if this session is still valid (not deleted or superseded by another run).
  const updateResult = db
    .prepare(
      `UPDATE ai_insights_sessions SET status = 'complete', completed = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(processedCount, nowUtc(), sessionId)

  // Clean up stale results (tasks no longer in the active list) only on successful
  // completion. Old results are preserved during generation so failures don't wipe data.
  if (updateResult.changes > 0 && tasks.length > 0) {
    const allTaskIds = tasks.map((t) => t.id)
    const placeholders = allTaskIds.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM ai_insights_results WHERE user_id = ? AND task_id NOT IN (${placeholders})`,
    ).run(userId, ...allTaskIds)
  }
}

/**
 * Store insights results for a batch (upsert).
 */
function storeInsightsResults(userId: number, items: InsightsItem[]): void {
  const db = getDb()
  const now = nowUtc()

  const stmt = db.prepare(
    `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, task_id) DO UPDATE SET
       score = excluded.score,
       commentary = excluded.commentary,
       signals = excluded.signals,
       generated_at = excluded.generated_at`,
  )

  for (const item of items) {
    const signals = item.signals.length > 0 ? JSON.stringify(item.signals) : null
    stmt.run(userId, item.task_id, item.score, item.commentary, signals, now)
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Get the status of an insights session for progress polling.
 */
export function getInsightsSessionStatus(
  sessionId: string,
  userId: number,
): InsightsSession | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM ai_insights_sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId) as InsightsSession | undefined
  return row ?? null
}

/**
 * Get cached insights results for a user.
 * Returns results sorted by score descending.
 */
export function getInsightsResults(userId: number): {
  results: InsightsResult[]
  generatedAt: string | null
  signalCounts: Record<string, number>
} {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT task_id, score, commentary, signals, generated_at
       FROM ai_insights_results
       WHERE user_id = ?
       ORDER BY score DESC`,
    )
    .all(userId) as {
    task_id: number
    score: number
    commentary: string
    signals: string | null
    generated_at: string
  }[]

  const signalCounts: Record<string, number> = {}
  const results: InsightsResult[] = rows.map((row) => {
    const signals: InsightsSignalKey[] = row.signals ? JSON.parse(row.signals) : []
    for (const s of signals) {
      signalCounts[s] = (signalCounts[s] || 0) + 1
    }
    return {
      task_id: row.task_id,
      score: row.score,
      commentary: row.commentary,
      signals,
      generated_at: row.generated_at,
    }
  })

  return {
    results,
    generatedAt: rows.length > 0 ? rows[0].generated_at : null,
    signalCounts,
  }
}

/**
 * Check if a user has any insights results (for showing cached vs empty state).
 */
export function hasInsightsResults(userId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) as count FROM ai_insights_results WHERE user_id = ?')
    .get(userId) as { count: number }
  return row.count > 0
}

/**
 * Get the most recent active session for a user (if any is still running).
 */
export function getActiveInsightsSession(userId: number): InsightsSession | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT * FROM ai_insights_sessions
       WHERE user_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId) as InsightsSession | undefined
  return row ?? null
}
