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
// Batch processing
// ---------------------------------------------------------------------------

const BATCH_SIZE = 25

/**
 * Format a task as a human-readable line for the review prompt.
 * Same format as bubble.ts for consistency.
 */
function formatTaskLine(t: TaskSummary, timezone: string, now: DateTime): string {
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
function formatAge(isoUtc: string, now: DateTime): string {
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
): { sessionId: string; totalTasks: number } {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()

  // Clear old results for this user
  db.prepare('DELETE FROM ai_review_results WHERE user_id = ?').run(userId)

  // Create session
  db.prepare(
    `INSERT INTO ai_review_sessions (id, user_id, status, total_tasks, completed, started_at)
     VALUES (?, ?, 'running', ?, 0, ?)`,
  ).run(sessionId, userId, tasks.length, now)

  // Start batch processing in background (fire-and-forget)
  processReviewBatches(sessionId, userId, timezone, tasks, userContext).catch((err) => {
    log.error('ai', 'Review generation failed:', err)
    db.prepare(
      `UPDATE ai_review_sessions SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(String(err), nowUtc(), sessionId)
  })

  return { sessionId, totalTasks: tasks.length }
}

/**
 * Process all task batches sequentially through the AI.
 */
async function processReviewBatches(
  sessionId: string,
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
): Promise<void> {
  const db = getDb()
  const batches: TaskSummary[][] = []

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    batches.push(tasks.slice(i, i + BATCH_SIZE))
  }

  const now = DateTime.now().setZone(timezone)
  const currentTime = now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'")
  const jsonSchema = z.toJSONSchema(ReviewBatchResultSchema)
  let processedCount = 0

  for (const batch of batches) {
    const taskLines = batch.map((t) => formatTaskLine(t, timezone, now)).join('\n')
    const taskIds = new Set(batch.map((t) => t.id))

    const userContextBlock = userContext ? `\nUser context: ${userContext}\n` : ''

    const prompt = `${REVIEW_SYSTEM_PROMPT}

## Context

Current time: ${currentTime}
Total tasks in full list: ${tasks.length}
Tasks in this batch: ${batch.length}${userContextBlock}

## Tasks

${taskLines}

Score every task in this batch. Return a JSON array with one entry per task.`

    try {
      const result = await aiQuery({
        prompt,
        outputSchema: jsonSchema,
        model: process.env.OPENTASK_AI_REVIEW_MODEL || 'haiku',
        maxTurns: 1,
        userId,
        action: 'review',
        inputText: `batch ${processedCount / BATCH_SIZE + 1}/${batches.length} (${batch.length} tasks)`,
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
        // Store results — only for tasks that were in this batch
        const validItems = parsed.filter((item) => taskIds.has(item.task_id))
        storeReviewResults(userId, validItems)
        processedCount += batch.length
      } else {
        log.warn('ai', `Review batch failed to parse — skipping ${batch.length} tasks`)
        processedCount += batch.length
      }
    } catch (err) {
      log.error('ai', `Review batch error:`, err)
      processedCount += batch.length
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
