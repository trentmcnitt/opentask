/**
 * AI Review — batch task scoring, commentary, and signal detection
 *
 * Processes the user's entire task list in batches, scoring each task 0-100
 * based on how much it needs attention, adding one-line commentary, and
 * optionally tagging tasks with signals from a preset vocabulary.
 *
 * Results are cached in `ai_review_results` for fast retrieval.
 * Generation progress is tracked in `ai_review_sessions` for polling.
 */

import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse, extractJsonFromText } from './parse-helpers'
import { REVIEW_SYSTEM_PROMPT } from './prompts'
import { ReviewBatchResultSchema } from './types'
import type { ReviewItem, ReviewSignalKey, TaskSummary } from './types'
import { log } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Signal vocabulary — display properties for UI rendering
// ---------------------------------------------------------------------------

export interface ReviewSignal {
  key: ReviewSignalKey
  label: string
  /** Tailwind color class prefix (e.g., 'indigo' → use bg-indigo-100, text-indigo-700) */
  color: string
  /** Lucide icon name */
  icon: string
  description: string
}

export const REVIEW_SIGNALS: ReviewSignal[] = [
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

export const SIGNAL_MAP = new Map(REVIEW_SIGNALS.map((s) => [s.key, s]))

// ---------------------------------------------------------------------------
// Review session types
// ---------------------------------------------------------------------------

export interface ReviewSession {
  id: string
  user_id: number
  status: 'running' | 'complete' | 'failed'
  total_tasks: number
  completed: number
  started_at: string
  finished_at: string | null
  error: string | null
}

export interface ReviewResult {
  task_id: number
  score: number
  commentary: string
  signals: ReviewSignalKey[]
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

/**
 * Strip signals that violate hard rules:
 * - act_soon requires P3+ (never P0-2)
 * - stale requires 21+ days old
 */
export function sanitizeSignals(items: ReviewItem[], taskMap: Map<number, TaskSummary>): void {
  for (const item of items) {
    const task = taskMap.get(item.task_id)
    if (!task || item.signals.length === 0) continue

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

/** Timeout for review AI calls (5 minutes) to accommodate large task lists. */
const REVIEW_TIMEOUT_MS = 300_000

/**
 * Format a task as a human-readable line for the review prompt.
 * Same format as bubble.ts for consistency.
 */
export function formatTaskLine(t: TaskSummary, timezone: string, now: DateTime): string {
  const due = t.due_at ? formatLocalDate(t.due_at, timezone) : 'none'
  const originalDue =
    t.priority >= 3 && t.original_due_at && t.original_due_at !== t.due_at
      ? ` (originally due: ${formatLocalDate(t.original_due_at, timezone)})`
      : ''
  const created = formatLocalDate(t.created_at, timezone)
  const createdAge = formatAge(t.created_at, now)
  const rrule = t.rrule ? `rrule: ${t.rrule}` : 'one-off'
  const recMode = t.recurrence_mode !== 'from_due' ? ` | recurrence_mode: ${t.recurrence_mode}` : ''
  const notes = t.notes ? ` | notes: ${t.notes}` : ''
  return (
    `- [${t.id}] "${t.title}" | priority: ${t.priority} | due: ${due}${originalDue} | ` +
    `created: ${created} (${createdAge}) | labels: ${t.labels.join(', ') || 'none'} | ` +
    `project: ${t.project_name || 'Inbox'} | ${rrule}${recMode}${notes}`
  )
}

function formatLocalDate(isoUtc: string, timezone: string): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(timezone)
  return dt.toFormat('ccc, LLL d, h:mm a')
}

/**
 * Pre-compute a human-readable age string from a UTC timestamp.
 * Prevents the AI from miscounting task age (a common hallucination).
 */
export function formatAge(isoUtc: string, now: DateTime): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' })
  const days = Math.floor(now.diff(dt, 'days').days)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks} week${weeks > 1 ? 's' : ''} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months > 1 ? 's' : ''} ago`
}

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
 * Start a review generation session and process tasks in background.
 *
 * Returns the session ID immediately. The caller polls getReviewSessionStatus()
 * to track progress.
 */
export function startReviewGeneration(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
): { sessionId: string; totalTasks: number; singleCall: boolean } {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()
  const singleCall = tasks.length <= SINGLE_CALL_THRESHOLD

  // Clear old results for this user
  db.prepare('DELETE FROM ai_review_results WHERE user_id = ?').run(userId)

  // Create session
  db.prepare(
    `INSERT INTO ai_review_sessions (id, user_id, status, total_tasks, completed, started_at)
     VALUES (?, ?, 'running', ?, 0, ?)`,
  ).run(sessionId, userId, tasks.length, now)

  // Start processing in background (fire-and-forget)
  processReviewChunks(sessionId, userId, timezone, tasks, userContext).catch((err) => {
    log.error('ai', 'Review generation failed:', err)
    db.prepare(
      `UPDATE ai_review_sessions SET status = 'failed', error = ?, finished_at = ?
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
async function processReviewChunks(
  sessionId: string,
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
): Promise<void> {
  const db = getDb()
  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const jsonSchema = z.toJSONSchema(ReviewBatchResultSchema)
  const userContextBlock = userContext ? `\nUser context: ${userContext}\n` : ''

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

    const prompt = `${REVIEW_SYSTEM_PROMPT}
${summaryBlock}
## Context

Current time: ${currentTime}
${contextBlock}${userContextBlock}

## Tasks

${taskLines}

Score every task below. Return a JSON array with one entry per task.`

    const inputLabel =
      chunks.length === 1
        ? `${tasks.length} tasks`
        : `chunk ${ci + 1}/${chunks.length} (${chunk.length} tasks)`

    try {
      const result = await aiQuery({
        prompt,
        outputSchema: jsonSchema,
        model: process.env.OPENTASK_AI_REVIEW_MODEL || 'haiku',
        maxTurns: 1,
        userId,
        action: 'review',
        inputText: inputLabel,
        timeoutMs: REVIEW_TIMEOUT_MS,
      })

      const parsed = parseAIResponse(result, ReviewBatchResultSchema, 'Review', (text) => {
        const json = extractJsonFromText(text)
        if (!json) return null

        // Handle both direct array and { tasks: [...] } wrapper
        const arr = Array.isArray(json) ? json : json.tasks
        if (!Array.isArray(arr)) return null

        const attempt = ReviewBatchResultSchema.safeParse(arr)
        return attempt.success ? attempt.data : null
      })

      if (parsed) {
        const validItems = parsed.filter((item) => taskIds.has(item.task_id))
        sanitizeSignals(validItems, taskMap)
        storeReviewResults(userId, validItems)
        processedCount += chunk.length
      } else {
        log.warn('ai', `Review chunk ${ci + 1} failed to parse — skipping ${chunk.length} tasks`)
        processedCount += chunk.length
      }
    } catch (err) {
      log.error('ai', `Review chunk ${ci + 1} error:`, err)
      processedCount += chunk.length
    }

    // Update session progress
    db.prepare('UPDATE ai_review_sessions SET completed = ? WHERE id = ?').run(
      processedCount,
      sessionId,
    )
  }

  // Mark session complete
  db.prepare(
    `UPDATE ai_review_sessions SET status = 'complete', completed = ?, finished_at = ?
     WHERE id = ?`,
  ).run(processedCount, nowUtc(), sessionId)
}

/**
 * Store review results for a batch (upsert).
 */
function storeReviewResults(userId: number, items: ReviewItem[]): void {
  const db = getDb()
  const now = nowUtc()

  const stmt = db.prepare(
    `INSERT INTO ai_review_results (user_id, task_id, score, commentary, signals, generated_at)
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
 * Get the status of a review session for progress polling.
 */
export function getReviewSessionStatus(sessionId: string, userId: number): ReviewSession | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM ai_review_sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId) as ReviewSession | undefined
  return row ?? null
}

/**
 * Get cached review results for a user.
 * Returns results sorted by score descending.
 */
export function getReviewResults(userId: number): {
  results: ReviewResult[]
  generatedAt: string | null
  signalCounts: Record<string, number>
} {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT task_id, score, commentary, signals, generated_at
       FROM ai_review_results
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
  const results: ReviewResult[] = rows.map((row) => {
    const signals: ReviewSignalKey[] = row.signals ? JSON.parse(row.signals) : []
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
 * Check if a user has any review results (for showing cached vs empty state).
 */
export function hasReviewResults(userId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) as count FROM ai_review_results WHERE user_id = ?')
    .get(userId) as { count: number }
  return row.count > 0
}

/**
 * Get the most recent active session for a user (if any is still running).
 */
export function getActiveReviewSession(userId: number): ReviewSession | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT * FROM ai_review_sessions
       WHERE user_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId) as ReviewSession | undefined
  return row ?? null
}
