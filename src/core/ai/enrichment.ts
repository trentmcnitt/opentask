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
import { isAIEnabled, aiQuery } from './sdk'
import { EnrichmentResultSchema } from './types'
import type { EnrichmentResult } from './types'
import { ENRICHMENT_SYSTEM_PROMPT } from './prompts'
import { z } from 'zod'

/** Simple lock to prevent concurrent queue processing */
let processing = false

/**
 * Process the enrichment queue. Called by cron every N seconds.
 *
 * Picks up tasks with ai_status='pending', processes them one at a time,
 * and applies the enrichment result. Sequential processing avoids
 * overwhelming the server with concurrent SDK subprocesses.
 */
export async function processEnrichmentQueue(): Promise<void> {
  if (!isAIEnabled()) return
  if (processing) return

  processing = true
  try {
    const db = getDb()

    // Pick up pending tasks (oldest first, limit to 5 per cycle)
    const pendingTasks = db
      .prepare(
        `SELECT id, user_id, title, labels, priority, due_at, rrule
         FROM tasks
         WHERE ai_status = 'pending' AND deleted_at IS NULL
         ORDER BY created_at ASC
         LIMIT 5`,
      )
      .all() as PendingTaskRow[]

    for (const row of pendingTasks) {
      try {
        // Check for ai-locked label
        const labels: string[] = JSON.parse(row.labels)
        if (labels.includes('ai-locked')) {
          db.prepare('UPDATE tasks SET ai_status = NULL WHERE id = ?').run(row.id)
          log.info('ai', `Task ${row.id} has ai-locked label, skipping enrichment`)
          continue
        }

        // Set status to processing (prevents double-processing)
        db.prepare("UPDATE tasks SET ai_status = 'processing', updated_at = ? WHERE id = ?").run(
          nowUtc(),
          row.id,
        )

        await enrichTask(row)
      } catch (err) {
        log.error('ai', `Enrichment failed for task ${row.id}:`, err)
        db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
          nowUtc(),
          row.id,
        )
      }
    }
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
 * Enrich a single task via the Claude Agent SDK.
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

  // Get available projects for project name resolution
  const projects = db
    .prepare('SELECT id, name FROM projects WHERE owner_id = ? ORDER BY sort_order')
    .all(user.id) as { id: number; name: string }[]

  const projectList = projects.map((p) => `- ${p.name} (id: ${p.id})`).join('\n')

  const prompt = `${ENRICHMENT_SYSTEM_PROMPT}

## Context

User's timezone: ${user.timezone}
Current UTC time: ${nowUtc()}

Available projects:
${projectList}

## Task to parse

"${row.title}"

Parse this task and return the structured result.`

  // Convert Zod schema to JSON Schema for the SDK
  const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)

  const result = await aiQuery({
    prompt,
    outputSchema: jsonSchema,
    model: process.env.OPENTASK_AI_ENRICHMENT_MODEL || 'haiku',
    maxTurns: 1,
    userId: row.user_id,
    taskId: row.id,
    action: 'enrich',
    inputText: row.title,
  })

  if (!result.success) {
    db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
    return
  }

  // Try structured output first, fall back to extracting JSON from text.
  // Some model/SDK configurations return text with embedded JSON code blocks
  // instead of using the structured output channel.
  let output = result.structuredOutput
  if (!output && result.textResult) {
    output = extractJsonFromText(result.textResult)
  }
  if (!output) {
    log.error('ai', `No structured output or parseable JSON for task ${row.id}`)
    db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
    return
  }

  // Validate the output against our schema
  const parsed = EnrichmentResultSchema.safeParse(output)
  if (!parsed.success) {
    log.error('ai', `Invalid enrichment output for task ${row.id}:`, parsed.error.message)
    db.prepare("UPDATE tasks SET ai_status = 'failed', updated_at = ? WHERE id = ?").run(
      nowUtc(),
      row.id,
    )
    return
  }

  applyEnrichment(row, parsed.data, user)
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

  // Project — resolve project name to ID if provided
  if (enrichment.project_name) {
    const db = getDb()
    const project = db
      .prepare('SELECT id FROM projects WHERE owner_id = ? AND name = ? COLLATE NOCASE')
      .get(user.id, enrichment.project_name) as { id: number } | undefined
    if (project && project.id !== task.project_id) {
      setClauses.push('project_id = ?')
      values.push(project.id)
      fieldsChanged.push('project_id')
    }
  }

  // Store original raw text in meta_notes for reference
  if (!task.meta_notes) {
    setClauses.push('meta_notes = ?')
    values.push(`AI enriched from: "${task.title}"`)
    fieldsChanged.push('meta_notes')
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
      .filter((f) => !['meta_notes', 'anchor_time', 'anchor_dow', 'anchor_dom'].includes(f))
      .join(', ')
    const description = `AI: Enriched task — set ${changeList}`

    const snapshot = createTaskSnapshot(task, updatedTask, changes.fieldsChanged)
    logAction(user.id, 'edit', description, changes.fieldsChanged, [snapshot])
  })

  log.info('ai', `Task ${row.id} enriched: ${changes.fieldsChanged.join(', ')}`)
}

/**
 * Extract a JSON object from a text response that may contain markdown
 * code blocks or other surrounding text. The SDK sometimes returns text
 * with embedded JSON instead of using the structured output channel.
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try the full text as JSON first
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not pure JSON
  }

  // Try extracting from a ```json code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]) as Record<string, unknown>
    } catch {
      // Invalid JSON in code block
    }
  }

  // Try finding the first { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>
    } catch {
      // Invalid JSON
    }
  }

  return null
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
