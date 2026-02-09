/**
 * Task enrichment pipeline
 *
 * Processes tasks with ai_status='pending' by sending their raw title text
 * to the Claude Agent SDK for structured extraction. The AI extracts a clean
 * title, due date, priority, labels, recurrence rule, and project assignment.
 *
 * The enrichment is applied through the standard mutation pattern:
 * withTransaction() + logAction() + createTaskSnapshot(), so all AI changes
 * appear in the undo history and can be reverted with Cmd+Z.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { getTaskById } from '@/core/tasks'
import { nowUtc, computeFirstOccurrence, deriveAnchorFields } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { log } from '@/lib/logger'
import { isAIEnabled } from './sdk'
import { EnrichmentResultSchema } from './types'
import type { EnrichmentResult } from './types'
import { isShoppingProject, getShoppingLabels, getProjectName } from './shopping'
import { enrichmentQuery } from './enrichment-slot'

/** Simple lock to prevent concurrent queue processing */
let processing = false

/**
 * Circuit breaker state.
 *
 * Tracks rapid consecutive failures to prevent infinite failure loops.
 * If CIRCUIT_BREAKER_THRESHOLD tasks fail within CIRCUIT_BREAKER_WINDOW_MS,
 * the queue pauses for CIRCUIT_BREAKER_PAUSE_MS before accepting new work.
 */
const CIRCUIT_BREAKER_THRESHOLD = 5
const CIRCUIT_BREAKER_WINDOW_MS = 60_000 // 1 minute
const CIRCUIT_BREAKER_PAUSE_MS = 300_000 // 5 minutes
const STUCK_TASK_TIMEOUT_MS = 120_000 // 2 minutes

interface CircuitBreakerState {
  failureTimestamps: number[]
  pausedUntil: number | null
}

const circuitBreaker: CircuitBreakerState = {
  failureTimestamps: [],
  pausedUntil: null,
}

/** Record a failure for circuit breaker tracking */
function recordFailure(): void {
  const now = Date.now()
  circuitBreaker.failureTimestamps.push(now)

  // Remove failures outside the window
  const cutoff = now - CIRCUIT_BREAKER_WINDOW_MS
  circuitBreaker.failureTimestamps = circuitBreaker.failureTimestamps.filter((t) => t > cutoff)

  if (circuitBreaker.failureTimestamps.length >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreaker.pausedUntil = now + CIRCUIT_BREAKER_PAUSE_MS
    circuitBreaker.failureTimestamps = []
    log.warn(
      'ai',
      `Circuit breaker tripped: ${CIRCUIT_BREAKER_THRESHOLD} failures in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s. ` +
        `Queue paused for ${CIRCUIT_BREAKER_PAUSE_MS / 1000}s.`,
    )
  }
}

/** Check if the circuit breaker is currently tripped */
function isCircuitBreakerOpen(): boolean {
  if (!circuitBreaker.pausedUntil) return false
  if (Date.now() >= circuitBreaker.pausedUntil) {
    circuitBreaker.pausedUntil = null
    log.info('ai', 'Circuit breaker reset — resuming queue processing')
    return false
  }
  return true
}

/** Exported for testing */
export function _resetCircuitBreaker(): void {
  circuitBreaker.failureTimestamps = []
  circuitBreaker.pausedUntil = null
}

/**
 * Reset tasks stuck in 'processing' for too long.
 *
 * If a task has been processing for longer than STUCK_TASK_TIMEOUT_MS,
 * it was likely interrupted without a clean server restart. Reset it
 * to 'pending' so it gets retried.
 */
function resetTimedOutTasks(): void {
  const db = getDb()
  const cutoff = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS).toISOString()
  const result = db
    .prepare(
      "UPDATE tasks SET ai_status = 'pending' WHERE ai_status = 'processing' AND updated_at < ?",
    )
    .run(cutoff)
  if (result.changes > 0) {
    log.warn(
      'ai',
      `Reset ${result.changes} timed-out tasks (processing > ${STUCK_TASK_TIMEOUT_MS / 1000}s)`,
    )
  }
}

/**
 * Process the enrichment queue. Called by cron every N seconds.
 *
 * Picks up tasks with ai_status='pending', processes them one at a time,
 * and applies the enrichment result. Sequential processing avoids
 * overwhelming the server with concurrent SDK subprocesses.
 *
 * Includes circuit breaker (pauses on rapid failures), timeout detection
 * (resets stuck tasks), and cycle stats logging.
 */
export async function processEnrichmentQueue(): Promise<void> {
  if (!isAIEnabled()) return
  if (processing) return
  if (isCircuitBreakerOpen()) return

  processing = true
  try {
    const db = getDb()

    // Reset tasks stuck in processing for too long
    resetTimedOutTasks()

    // Pick up pending tasks with round-robin fairness across users.
    // Groups by user, picks the oldest pending task per user first,
    // then cycles through users until the batch limit is reached.
    const pendingTasks = db
      .prepare(
        `SELECT id, user_id, title, labels, priority, due_at, rrule
         FROM tasks
         WHERE ai_status = 'pending' AND deleted_at IS NULL
         ORDER BY user_id, created_at ASC
         LIMIT 20`,
      )
      .all() as PendingTaskRow[]

    // Round-robin: interleave tasks from different users
    const byUser = new Map<number, PendingTaskRow[]>()
    for (const row of pendingTasks) {
      const userTasks = byUser.get(row.user_id) ?? []
      userTasks.push(row)
      byUser.set(row.user_id, userTasks)
    }
    const fairQueue: PendingTaskRow[] = []
    const userQueues = [...byUser.values()]
    let idx = 0
    while (fairQueue.length < 10 && userQueues.some((q) => q.length > 0)) {
      const queue = userQueues[idx % userQueues.length]
      if (queue.length > 0) {
        fairQueue.push(queue.shift()!)
      }
      idx++
    }

    if (fairQueue.length === 0) return

    let processed = 0
    let failed = 0
    let skipped = 0

    for (const row of fairQueue) {
      try {
        // Check for ai-locked label
        const labels: string[] = JSON.parse(row.labels)
        if (labels.includes('ai-locked')) {
          db.prepare('UPDATE tasks SET ai_status = NULL WHERE id = ?').run(row.id)
          log.info('ai', `Task ${row.id} has ai-locked label, skipping enrichment`)
          skipped++
          continue
        }

        // Set status to processing (prevents double-processing)
        db.prepare("UPDATE tasks SET ai_status = 'processing', updated_at = ? WHERE id = ?").run(
          nowUtc(),
          row.id,
        )

        await enrichTask(row)
        processed++
      } catch (err) {
        log.error('ai', `Enrichment failed for task ${row.id}:`, err)
        db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
          nowUtc(),
          row.id,
        )
        failed++
        recordFailure()

        // Stop processing this cycle if circuit breaker tripped
        if (isCircuitBreakerOpen()) break
      }
    }

    log.info(
      'ai',
      `Queue cycle: ${processed} processed, ${failed} failed, ${skipped} skipped` +
        ` (${fairQueue.length} picked up)`,
    )
  } finally {
    processing = false
  }
}

/**
 * Reset stuck tasks on startup.
 *
 * Tasks with ai_status='processing' were interrupted by a server restart.
 * Reset them to 'pending' so they get picked up again.
 */
export function resetStuckTasks(): void {
  const db = getDb()
  const result = db
    .prepare("UPDATE tasks SET ai_status = 'pending' WHERE ai_status = 'processing'")
    .run()
  if (result.changes > 0) {
    log.info('ai', `Reset ${result.changes} stuck tasks from 'processing' to 'pending'`)
  }
}

/**
 * Enrich a single task by ID. Public entry point for on-demand enrichment.
 *
 * Called fire-and-forget from the task creation API route. Checks that the
 * task has ai_status='pending', sets it to 'processing', runs enrichTask(),
 * and handles success/failure status updates.
 */
export async function enrichSingleTask(taskId: number, userId: number): Promise<void> {
  if (!isAIEnabled()) return

  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, user_id, title, labels, priority, due_at, rrule
       FROM tasks WHERE id = ? AND user_id = ? AND ai_status = 'pending' AND deleted_at IS NULL`,
    )
    .get(taskId, userId) as PendingTaskRow | undefined

  if (!row) return

  // Check for ai-locked label
  const labels: string[] = JSON.parse(row.labels)
  if (labels.includes('ai-locked')) {
    db.prepare('UPDATE tasks SET ai_status = NULL WHERE id = ?').run(row.id)
    log.info('ai', `Task ${row.id} has ai-locked label, skipping enrichment`)
    return
  }

  db.prepare("UPDATE tasks SET ai_status = 'processing', updated_at = ? WHERE id = ?").run(
    nowUtc(),
    row.id,
  )

  try {
    await enrichTask(row)
  } catch (err) {
    log.error('ai', `On-demand enrichment failed for task ${row.id}:`, err)
    db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
  }
}

/**
 * Enrich a single task via the warm enrichment slot.
 *
 * Sends the raw title text with the user's timezone to the model,
 * gets back structured output, validates it, and applies changes.
 */
async function enrichTask(row: PendingTaskRow): Promise<void> {
  const db = getDb()

  // Get user's timezone for date conversion
  const user = db.prepare('SELECT id, timezone FROM users WHERE id = ?').get(row.user_id) as
    | { id: number; timezone: string }
    | undefined
  if (!user) {
    throw new Error(`User ${row.user_id} not found`)
  }

  // Get available projects for project name resolution (owned + shared)
  const projects = db
    .prepare(
      'SELECT id, name, shared FROM projects WHERE owner_id = ? OR shared = 1 ORDER BY sort_order',
    )
    .all(user.id) as { id: number; name: string; shared: number }[]

  const projectList = projects
    .map((p) => `- ${p.name} (id: ${p.id}${p.shared ? ', shared' : ''})`)
    .join('\n')

  const prompt = `## Context

User's timezone: ${user.timezone}
Current UTC time: ${nowUtc()}

Available projects:
${projectList}

## Task to parse

"${row.title}"

Parse this task and return the structured result.`

  const result = await enrichmentQuery(prompt, {
    userId: row.user_id,
    taskId: row.id,
    inputText: row.title,
  })

  // Parse and validate the enrichment result
  let parsed: EnrichmentResult | null = null
  if (result.structuredOutput) {
    const validation = EnrichmentResultSchema.safeParse(result.structuredOutput)
    if (validation.success) {
      parsed = validation.data
    } else {
      log.error('ai', `Enrichment[${row.id}]: invalid structured output:`, validation.error.message)
    }
  }
  if (!parsed && result.text) {
    // Try extracting JSON from text response
    try {
      const json = JSON.parse(result.text)
      const validation = EnrichmentResultSchema.safeParse(json)
      if (validation.success) parsed = validation.data
    } catch {
      // Not valid JSON text
    }
  }

  if (!parsed) {
    db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
    return
  }

  applyEnrichment(row, parsed, user)

  // Post-enrichment: add shopping labels if the task is in a shopping project.
  // Check the resolved project (after enrichment may have moved it).
  const enrichedTask = getTaskById(row.id)
  if (enrichedTask) {
    const projectName = getProjectName(enrichedTask.project_id)
    if (projectName && isShoppingProject(projectName)) {
      try {
        const shoppingLabels = await getShoppingLabels(row.user_id, enrichedTask.title, projectName)
        if (shoppingLabels.length > 0) {
          const existingLabels = new Set(enrichedTask.labels)
          const newLabels = shoppingLabels.filter((l) => !existingLabels.has(l))
          if (newLabels.length > 0) {
            // Use withTransaction + logAction for atomic, undoable shopping label updates.
            // Re-read beforeTask inside the transaction to capture the true pre-mutation
            // state — the enrichedTask reference was captured before the async SDK call.
            withTransaction((txDb) => {
              const beforeTask = getTaskById(row.id)!
              const merged = [...beforeTask.labels, ...newLabels]
              txDb
                .prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(merged), nowUtc(), row.id)
              const afterTask = getTaskById(row.id)!
              const snapshot = createTaskSnapshot(beforeTask, afterTask, ['labels'])
              logAction(
                user.id,
                'edit',
                `AI: Added shopping labels — ${newLabels.join(', ')}`,
                ['labels'],
                [snapshot],
              )
            })
            log.info('ai', `Task ${row.id} shopping labels added: ${newLabels.join(', ')}`)
          }
        }
      } catch (err) {
        // Shopping label failure is non-fatal — enrichment still succeeded
        log.warn('ai', `Shopping label enrichment failed for task ${row.id}:`, err)
      }
    }
  }
}

interface FieldChanges {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
}

/**
 * Collect field changes from enrichment result.
 *
 * Compares the AI output against the existing task and builds SET clauses
 * for only the fields that should change. Does not clobber existing values.
 */
function collectEnrichmentChanges(
  task: Task,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
): FieldChanges {
  const setClauses: string[] = []
  const values: unknown[] = []
  const fieldsChanged: string[] = []

  // Title — always update (the AI should always produce a clean title)
  if (enrichment.title && enrichment.title !== task.title) {
    setClauses.push('title = ?')
    values.push(enrichment.title)
    fieldsChanged.push('title')
  }

  // Due date — only set if not already set
  if (enrichment.due_at && !task.due_at) {
    setClauses.push('due_at = ?')
    values.push(enrichment.due_at)
    fieldsChanged.push('due_at')
  }

  // Priority — only set if currently unset (0)
  if (enrichment.priority > 0 && task.priority === 0) {
    setClauses.push('priority = ?')
    values.push(enrichment.priority)
    fieldsChanged.push('priority')
  }

  // Labels — merge with existing (don't replace)
  if (enrichment.labels.length > 0) {
    const existingLabels = new Set(task.labels)
    const newLabels = enrichment.labels.filter((l) => !existingLabels.has(l))
    if (newLabels.length > 0) {
      const merged = [...task.labels, ...newLabels]
      setClauses.push('labels = ?')
      values.push(JSON.stringify(merged))
      fieldsChanged.push('labels')
    }
  }

  // RRULE — only set if not already set
  if (enrichment.rrule && !task.rrule) {
    setClauses.push('rrule = ?')
    values.push(enrichment.rrule)
    fieldsChanged.push('rrule')

    // Derive anchor fields from the new rrule
    const dueAt = enrichment.due_at || task.due_at
    const anchors = deriveAnchorFields(enrichment.rrule, dueAt, user.timezone)
    setClauses.push('anchor_time = ?', 'anchor_dow = ?', 'anchor_dom = ?')
    values.push(anchors.anchor_time, anchors.anchor_dow, anchors.anchor_dom)
    fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')

    // Compute first occurrence if no due_at
    if (!task.due_at && !enrichment.due_at) {
      const firstOccurrence = computeFirstOccurrence(enrichment.rrule, null, user.timezone)
      setClauses.push('due_at = ?')
      values.push(firstOccurrence.toISOString())
      if (!fieldsChanged.includes('due_at')) fieldsChanged.push('due_at')
    }
  }

  // Project — resolve project name to ID if provided (owned or shared)
  if (enrichment.project_name) {
    const db = getDb()
    const project = db
      .prepare(
        'SELECT id FROM projects WHERE (owner_id = ? OR shared = 1) AND name = ? COLLATE NOCASE',
      )
      .get(user.id, enrichment.project_name) as { id: number } | undefined
    if (project && project.id !== task.project_id) {
      setClauses.push('project_id = ?')
      values.push(project.id)
      fieldsChanged.push('project_id')
    }
  }

  return { setClauses, values, fieldsChanged }
}

/**
 * Apply enrichment results to a task.
 *
 * Uses withTransaction() + logAction() to ensure the mutation is atomic
 * and logged for undo. Only updates fields that the AI actually extracted
 * (doesn't clobber existing values).
 */
function applyEnrichment(
  row: PendingTaskRow,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
): void {
  const task = getTaskById(row.id)
  if (!task) return

  const changes = collectEnrichmentChanges(task, enrichment, user)

  if (changes.fieldsChanged.length === 0) {
    const db = getDb()
    db.prepare("UPDATE tasks SET ai_status = 'complete', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
    log.info('ai', `Task ${row.id} enriched — no changes needed`)
    return
  }

  // Add ai_status and updated_at to the SET clauses.
  // ai_status is NOT included in fieldsChanged — undo should not revert it to
  // 'pending', which would cause the cron to re-enrich and undo the user's undo.
  changes.setClauses.push("ai_status = 'complete'")
  changes.setClauses.push('updated_at = ?')
  changes.values.push(nowUtc())
  changes.values.push(row.id) // for WHERE clause

  withTransaction((db) => {
    const sql = `UPDATE tasks SET ${changes.setClauses.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...changes.values)

    const updatedTask = getTaskById(row.id)
    if (!updatedTask) throw new Error('Failed to retrieve enriched task')

    const changeList = changes.fieldsChanged
      .filter((f) => !['anchor_time', 'anchor_dow', 'anchor_dom'].includes(f))
      .join(', ')
    const description = `AI: Enriched task — set ${changeList}`

    const snapshot = createTaskSnapshot(task, updatedTask, changes.fieldsChanged)
    logAction(user.id, 'edit', description, changes.fieldsChanged, [snapshot])
  })

  log.info('ai', `Task ${row.id} enriched: ${changes.fieldsChanged.join(', ')}`)
}

interface PendingTaskRow {
  id: number
  user_id: number
  title: string
  labels: string
  priority: number
  due_at: string | null
  rrule: string | null
}
