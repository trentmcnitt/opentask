/**
 * Task enrichment pipeline — label-based state machine
 *
 * Tasks with the `ai-to-process` label are picked up by the queue or
 * fire-and-forget path. The AI extracts a clean title, due date, priority,
 * labels, recurrence rule, and project assignment.
 *
 * State machine:
 *   [New title-only task] → add `ai-to-process` label
 *   [Fire-and-forget or cron picks up task with `ai-to-process`]
 *     → Success: remove `ai-to-process`, apply enrichment
 *     → Failure attempt 1: keep `ai-to-process` (retry on next cycle)
 *     → Failure attempt 2: remove `ai-to-process`, add `ai-failed`
 *   [Task has both `ai-locked` + `ai-to-process`] → skip (ai-locked wins),
 *     remove `ai-to-process`
 *
 * Processing guard: in-memory Set<number> of task IDs currently being
 * processed prevents double-processing. Resets naturally on restart.
 *
 * Retry tracking: in-memory Map<number, number> (taskId → attempt count).
 * After 2 failed attempts, swap `ai-to-process` → `ai-failed`. Resets on
 * restart (giving tasks fresh attempts).
 *
 * The enrichment is applied through the standard mutation pattern:
 * withTransaction() + logAction() + createTaskSnapshot(), so all AI changes
 * appear in the undo history and can be reverted with Cmd+Z.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { getTaskById } from '@/core/tasks'
import {
  nowUtc,
  computeFirstOccurrence,
  deriveAnchorFields,
  parseRRule,
  getDayOfWeek,
} from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { isAIEnabled } from './sdk'
import { buildEnrichmentUserPrompt, buildReminderEnrichmentUserPrompt } from './prompts'
import { listTimeSlots } from '@/core/time-slots'
import { currentSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { parseCadence, buildSchedule } from '@/lib/reminder-rule'
import { EnrichmentResultSchema } from './types'
import type { EnrichmentResult } from './types'
import { enrichmentQuery } from './enrichment-slot'
import { enrichmentApiQuery } from './enrichment-api'
import { resolveFeatureAIConfig } from './models'
import { getUserFeatureModes, resolveFeatureTimeout } from './user-context'
import { DateTime } from 'luxon'
import { emitSyncEvent, emitEnrichmentCompleteEvent } from '@/lib/sync-events'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRule } from '@/lib/format-rrule'
import { getPriorityOption } from '@/lib/priority'
import { validateLabelsExist, filterAutoCreatableLabels } from '@/core/labels'

/** Simple lock to prevent concurrent queue processing */
let processing = false

/** In-memory set of task IDs currently being processed (prevents double-processing) */
const processingTasks = new Set<number>()

/** In-memory retry tracking (taskId → attempt count). Resets on restart. */
const retryCount = new Map<number, number>()

const MAX_ATTEMPTS = 2

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
    notifyError(
      'circuit-breaker',
      'AI circuit breaker tripped',
      `${CIRCUIT_BREAKER_THRESHOLD} failures in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s. Queue paused for ${CIRCUIT_BREAKER_PAUSE_MS / 1000}s.`,
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

/** Exported for testing */
export function _resetProcessingState(): void {
  processingTasks.clear()
  retryCount.clear()
}

/** Get enrichment pipeline status for observability. */
export function getEnrichmentPipelineStatus(): {
  processingTaskIds: number[]
  circuitBreakerOpen: boolean
} {
  return {
    processingTaskIds: [...processingTasks],
    circuitBreakerOpen: isCircuitBreakerOpen(),
  }
}

/**
 * Replace a label on a task. Removes `oldLabel` and adds `newLabel` atomically.
 * If `newLabel` is null, just removes `oldLabel`.
 */
function swapLabel(taskId: number, oldLabel: string, newLabel: string | null): void {
  const db = getDb()
  const task = getTaskById(taskId)
  if (!task) return

  const labels = task.labels.filter((l) => l !== oldLabel)
  if (newLabel && !labels.includes(newLabel)) {
    labels.push(newLabel)
  }
  db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(labels),
    nowUtc(),
    taskId,
  )
}

/**
 * Remove a label from a task.
 */
function removeLabel(taskId: number, label: string): void {
  swapLabel(taskId, label, null)
}

/**
 * Handle enrichment failure for a task.
 *
 * Tracks attempts in-memory. On first failure, keeps `ai-to-process` for retry.
 * On second failure, swaps `ai-to-process` → `ai-failed`.
 */
function handleFailure(taskId: number): void {
  const attempts = (retryCount.get(taskId) ?? 0) + 1
  retryCount.set(taskId, attempts)

  if (attempts >= MAX_ATTEMPTS) {
    swapLabel(taskId, 'ai-to-process', 'ai-failed')
    retryCount.delete(taskId)
    log.warn(
      'ai',
      `Task ${taskId} enrichment failed after ${MAX_ATTEMPTS} attempts — marked ai-failed`,
    )
  } else {
    log.info(
      'ai',
      `Task ${taskId} enrichment failed (attempt ${attempts}/${MAX_ATTEMPTS}) — will retry`,
    )
  }
}

/**
 * Process the enrichment queue. Called by cron every minute.
 *
 * Picks up tasks with the `ai-to-process` label (excluding those with
 * `ai-locked`), processes them one at a time, and applies the enrichment
 * result. Sequential processing avoids overwhelming the server with
 * concurrent SDK subprocesses.
 *
 * Includes circuit breaker (pauses on rapid failures) and cycle stats logging.
 */
export async function processEnrichmentQueue(): Promise<void> {
  if (!isAIEnabled()) return
  if (processing) return
  if (isCircuitBreakerOpen()) return

  processing = true
  try {
    const db = getDb()

    // Pick up tasks with ai-to-process label.
    // Uses json_each() to query the JSON labels array.
    // ai-locked filtering is done in the processing loop (so we can clean up
    // the ai-to-process label when both labels are present).
    const pendingTasks = db
      .prepare(
        `SELECT id, user_id, title, original_title, labels, priority, due_at, rrule, is_reminder
         FROM tasks
         WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')
           AND deleted_at IS NULL
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
      // Skip if already being processed (in-memory guard)
      if (processingTasks.has(row.id)) {
        skipped++
        continue
      }

      // Check for ai-locked label (sole guard — in-memory since the query doesn't filter by label)
      const labels: string[] = JSON.parse(row.labels)
      if (labels.includes('ai-locked')) {
        removeLabel(row.id, 'ai-to-process')
        log.info('ai', `Task ${row.id} has ai-locked label, removing ai-to-process`)
        skipped++
        continue
      }

      processingTasks.add(row.id)
      try {
        const enrichedFields = await enrichTask(row)
        retryCount.delete(row.id)
        processed++
        // The queue normally only refreshes tabs silently — the toast belongs to
        // the on-demand path. A reminder is the exception: it is enriched from a
        // quick add that already promised the user a slot ("Added to Evening"),
        // and when the AI moves it the surface has to say so. Whenever the warm
        // slot is unavailable the on-demand call fails and this cycle is what
        // actually does the work, so without this the explanation is simply lost.
        if (row.is_reminder === 1) emitEnrichmentComplete(row.id, row.user_id, enrichedFields)
      } catch (err) {
        log.error('ai', `Enrichment failed for task ${row.id}:`, err)
        handleFailure(row.id)
        failed++
        recordFailure()

        // Stop processing this cycle if circuit breaker tripped
        if (isCircuitBreakerOpen()) break
      } finally {
        processingTasks.delete(row.id)
      }

      // Notify connected tabs so the AI glow stops and enriched data appears
      emitSyncEvent(row.user_id)
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
 * Build a concise toast description from enrichment results.
 * Shows actual values (not field names): "Tomorrow 9:00 AM · Medium · Shopping"
 */
function buildEnrichmentDescription(
  task: Task,
  fieldsChanged: string[],
  userTimezone: string,
  projectName?: string,
): string | undefined {
  const parts: string[] = []

  // A reminder's due_at is bookkeeping for "which occurrence is next", never a
  // deadline, so saying "in 5 days" about one would be describing debt it does
  // not carry. Its schedule alone is the news.
  if (!task.is_reminder && fieldsChanged.includes('due_at') && task.due_at) {
    parts.push(formatDueTimeParts(task.due_at, userTimezone).relative)
  }

  if (fieldsChanged.includes('rrule') && task.rrule) {
    parts.push(formatRRule(task.rrule, task.anchor_time))
  }

  if (fieldsChanged.includes('priority') && task.priority > 0) {
    parts.push(getPriorityOption(task.priority).label)
  }

  if (fieldsChanged.includes('project_id') && projectName) {
    parts.push(projectName)
  }

  if (fieldsChanged.includes('labels')) {
    const displayLabels = task.labels.filter((l) => !l.startsWith('ai-'))
    if (displayLabels.length > 0) {
      parts.push(displayLabels.join(', '))
    }
  }

  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Enrich a single task by ID. Public entry point for on-demand enrichment.
 *
 * Called fire-and-forget from the task creation API route. Checks that the
 * task has the `ai-to-process` label, guards against double-processing,
 * runs enrichTask(), and handles success/failure.
 */
export async function enrichSingleTask(taskId: number, userId: number): Promise<void> {
  if (!isAIEnabled()) return
  if (processingTasks.has(taskId)) return

  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, user_id, title, original_title, labels, priority, due_at, rrule, is_reminder
       FROM tasks
       WHERE id = ? AND user_id = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')`,
    )
    .get(taskId, userId) as PendingTaskRow | undefined

  if (!row) return

  // Check for ai-locked label
  const labels: string[] = JSON.parse(row.labels)
  if (labels.includes('ai-locked')) {
    removeLabel(row.id, 'ai-to-process')
    log.info('ai', `Task ${row.id} has ai-locked label, removing ai-to-process`)
    return
  }

  processingTasks.add(taskId)
  let enrichmentSucceeded = false
  let enrichedFields: string[] = []
  try {
    enrichedFields = await enrichTask(row)
    retryCount.delete(taskId)
    enrichmentSucceeded = true
  } catch (err) {
    log.error('ai', `On-demand enrichment failed for task ${row.id}:`, err)
    handleFailure(taskId)
  } finally {
    processingTasks.delete(taskId)
  }

  // Notify all connected tabs so the AI glow stops and enriched data appears
  emitSyncEvent(userId)

  // Tell open tabs what the AI did, so the change can be explained rather than
  // just appearing.
  if (enrichmentSucceeded) emitEnrichmentComplete(taskId, userId, enrichedFields)
}

/**
 * Announce a finished enrichment to the user's open tabs.
 *
 * The payload's `description` is the whole point: it is what a surface shows to
 * explain a change the user did not make. Without it a reminder quietly jumps
 * from one time slot to another a second after it was typed, which reads as a
 * bug rather than as the AI doing its job.
 */
function emitEnrichmentComplete(taskId: number, userId: number, enrichedFields: string[]): void {
  const db = getDb()
  const enrichedTask = getTaskById(taskId)
  if (!enrichedTask) return

  const userRow = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
    | { timezone: string }
    | undefined
  const projectName = enrichedTask.project_id
    ? (
        db.prepare('SELECT name FROM projects WHERE id = ?').get(enrichedTask.project_id) as
          | { name: string }
          | undefined
      )?.name
    : undefined

  emitEnrichmentCompleteEvent(userId, {
    taskId,
    title: enrichedTask.title,
    description: buildEnrichmentDescription(
      enrichedTask,
      enrichedFields,
      userRow?.timezone ?? 'America/Chicago',
      projectName,
    ),
    due_at: enrichedTask.due_at,
    priority: enrichedTask.priority,
  })
}

/**
 * Choose and render the prompt for one pending row.
 *
 * A reminder is parsed against the user's editable time slots, not their
 * workday, and against its own instruction list — see
 * `buildReminderEnrichmentUserPrompt` for why that is a separate prompt rather
 * than a branch inside the task one. The slots come back with the prompt
 * because the sanitizer needs the same ones the model was shown.
 */
function buildPromptFor(
  row: PendingTaskRow,
  user: {
    id: number
    timezone: string
    ai_context: string | null
    morning_time: string
    wake_time: string
    sleep_time: string
  },
  projects: Array<{ id: number; name: string; shared: number }>,
  textToEnrich: string,
): { prompt: string; isReminder: boolean; slots: TimeSlot[]; currentSlotLabel: string | null } {
  if (row.is_reminder !== 1) {
    return {
      isReminder: false,
      slots: [],
      currentSlotLabel: null,
      prompt: buildEnrichmentUserPrompt({
        timezone: user.timezone,
        morningTime: user.morning_time,
        wakeTime: user.wake_time,
        sleepTime: user.sleep_time,
        projects,
        userContext: user.ai_context,
        taskText: textToEnrich,
      }),
    }
  }

  const slots = listTimeSlots(user.id)
  const currentSlotLabel = currentSlot(slots, user.timezone)?.label ?? null
  return {
    isReminder: true,
    slots,
    currentSlotLabel,
    prompt: buildReminderEnrichmentUserPrompt({
      timezone: user.timezone,
      slots,
      currentSlotLabel,
      userContext: user.ai_context,
      taskText: textToEnrich,
    }),
  }
}

/**
 * Enrich a single task via the warm enrichment slot.
 *
 * Sends the raw title text with the user's timezone to the model,
 * gets back structured output, validates it, and applies changes.
 */
async function enrichTask(row: PendingTaskRow): Promise<string[]> {
  const db = getDb()

  // Get user's timezone, AI context, and schedule preferences
  const user = db
    .prepare(
      'SELECT id, timezone, ai_context, morning_time, wake_time, sleep_time FROM users WHERE id = ?',
    )
    .get(row.user_id) as
    | {
        id: number
        timezone: string
        ai_context: string | null
        morning_time: string
        wake_time: string
        sleep_time: string
      }
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

  // Use original_title when available (preserves raw dictated input for re-enrichment).
  // Legacy tasks with null original_title fall back to current title.
  const textToEnrich = row.original_title || row.title

  const { prompt, isReminder, slots, currentSlotLabel } = buildPromptFor(
    row,
    user,
    projects,
    textToEnrich,
  )

  const modes = getUserFeatureModes(row.user_id)
  if (modes.enrichment === 'off') {
    removeLabel(row.id, 'ai-to-process')
    log.info(
      'ai',
      `Task ${row.id}: enrichment disabled for user ${row.user_id}, removing ai-to-process`,
    )
    return []
  }

  const timeoutMs = resolveFeatureTimeout(row.user_id, 'enrichment', modes.enrichment)
  const queryOptions = { userId: row.user_id, taskId: row.id, inputText: textToEnrich, timeoutMs }
  let result: {
    structuredOutput: Record<string, unknown> | null
    text: string | null
    durationMs: number
  }
  if (modes.enrichment === 'sdk') {
    result = await enrichmentQuery(prompt, queryOptions)
  } else {
    const config = resolveFeatureAIConfig('enrichment', modes.enrichment)
    result = await enrichmentApiQuery(prompt, {
      ...queryOptions,
      providerConfig: config.providerConfig,
      model: config.model,
      provider: config.provider,
    })
  }

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
    // Try extracting JSON from text response.
    // The model sometimes wraps JSON in markdown code fences (```json ... ```),
    // so strip those before parsing.
    let textToParse = result.text.trim()
    const fenceMatch = textToParse.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/)
    if (fenceMatch) textToParse = fenceMatch[1]
    try {
      const json = JSON.parse(textToParse)
      const validation = EnrichmentResultSchema.safeParse(json)
      if (validation.success) parsed = validation.data
    } catch {
      // Not valid JSON text
    }
  }

  if (!parsed) {
    throw new Error('Failed to parse enrichment result')
  }

  if (isReminder) parsed = sanitizeReminderEnrichment(parsed, slots, currentSlotLabel)

  // Convert due_at from local time to UTC using Luxon.
  // The AI returns local time (no Z, no offset). Luxon handles DST transitions
  // correctly for the target date, unlike naive Date() parsing.
  if (parsed.due_at) {
    let dueAt = parsed.due_at
    // Defensive: strip Z suffix or offset if AI includes one despite instructions
    dueAt = dueAt.replace(/Z$/i, '').replace(/[+-]\d{2}:?\d{2}$/, '')
    let local = DateTime.fromISO(dueAt, { zone: user.timezone })
    if (local.isValid) {
      if (parsed.rrule) {
        const snapped = snapDueAtToByday(local, parsed.rrule)
        if (snapped !== local) {
          log.warn(
            'ai',
            `Enrichment[${row.id}]: AI due_at "${parsed.due_at}" conflicts with RRULE "${parsed.rrule}" — snapped ${local.toISO()} → ${snapped.toISO()}`,
          )
          local = snapped
        }
      }
      parsed = { ...parsed, due_at: local.toUTC().toISO()! }
    } else {
      log.warn('ai', `Enrichment[${row.id}]: invalid due_at "${parsed.due_at}", setting to null`)
      parsed = { ...parsed, due_at: null }
    }
  }

  return applyEnrichment(row, parsed, user, textToEnrich)
}

/**
 * Post-parse guard for reminders (REDESIGN-V03 §6).
 *
 * The prompt asks for a rule pinned to one of the user's time slots and for
 * every task-shaped field to be left empty. Models comply most of the time, so
 * this enforces it — the same belt-and-suspenders stance as
 * `filterExplicitLabels`. Without it, one stray `due_at` gives a reminder a
 * deadline it can never miss, and a BYHOUR of 19 puts a thought in a slot the
 * user does not have.
 *
 * Rebuilding the rule through parseCadence/buildSchedule also canonicalizes it,
 * so a model that answers `FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0` to a rule
 * that already reads `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` produces no change, no
 * undo entry, and no toast for an edit that never happened.
 */
/** The slot whose start time is closest to `minutes`, earlier or later. */
function nearestSlot(minutes: number, slots: TimeSlot[]): TimeSlot | null {
  let best: TimeSlot | null = null
  let bestDistance = Infinity
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null) continue
    const distance = Math.abs(start - minutes)
    if (distance < bestDistance) {
      bestDistance = distance
      best = slot
    }
  }
  return best
}

export function sanitizeReminderEnrichment(
  enrichment: EnrichmentResult,
  slots: TimeSlot[],
  currentSlotLabel: string | null,
): EnrichmentResult {
  // Everything a reminder does not carry, cleared regardless of what came back.
  const base: EnrichmentResult = {
    ...enrichment,
    due_at: null,
    labels: [],
    project_name: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
  }

  // No usable rule: keep whatever the reminder already had rather than
  // clearing its schedule, which would strand it out of every slot.
  if (!enrichment.rrule || !/FREQ=/i.test(enrichment.rrule)) return { ...base, rrule: null }

  const hourMatch = /(?:^|;)BYHOUR=(\d{1,2})/i.exec(enrichment.rrule)
  const minuteMatch = /(?:^|;)BYMINUTE=(\d{1,2})/i.exec(enrichment.rrule)
  const stated = hourMatch
    ? parseInt(hourMatch[1], 10) * 60 + (minuteMatch ? parseInt(minuteMatch[1], 10) : 0)
    : null

  // A stated time snaps to the NEAREST slot, not the one it falls inside.
  // Falling inside is how a reminder is displayed, but a stated time is a near
  // miss to be corrected: a model that answers 7pm for "evening" meant this
  // user's 8:30pm Evening, and rounding down would drop it into Afternoon,
  // three hours from what was asked for. No stated time at all is different —
  // the model said nothing about when, so the slot the user is living in now
  // is the answer.
  const slot =
    stated === null
      ? (slots.find((s) => s.label === currentSlotLabel) ?? nearestSlot(0, slots))
      : nearestSlot(stated, slots)
  const minutes = slot ? parseHHMM(slot.start_time) : stated
  if (minutes === null) return { ...base, rrule: null }

  return { ...base, rrule: buildSchedule({ ...parseCadence(enrichment.rrule), time: minutes }) }
}

/**
 * Post-parse guard: if the RRULE specifies BYDAY, ensure due_at's weekday matches.
 * Models occasionally emit a weekday adjacent to the intended one (off-by-one on
 * "next Thursday"). Snap forward to the nearest valid BYDAY, preserving the
 * hour/minute/second. Returns the original DateTime when no snap is needed.
 */
function snapDueAtToByday(local: DateTime, rrule: string): DateTime {
  const components = parseRRule(rrule)
  if (!components.byday || components.byday.length === 0) return local
  const dow = getDayOfWeek(local)
  if (components.byday.includes(dow)) return local
  const forwardDistances = components.byday.map((d) => (d - dow + 7) % 7 || 7)
  const minDistance = Math.min(...forwardDistances)
  return local.plus({ days: minDistance })
}

/**
 * Post-parse guard: strip AI-inferred labels unless the user's input
 * contains explicit label-intent language. The prompt already tells the AI not
 * to infer labels, but this catches any prompt leakage.
 *
 * - If the input has no label-intent keywords, all labels are stripped.
 * - If label-intent keywords are present, trust the AI's extraction.
 */
function filterExplicitLabels(labels: string[], inputText: string): string[] {
  const labelIntentPattern = /\b(label\s+it|tag\s+it|mark\s+it\s+as|add\s+the\s+\w+\s+label)\b/i
  if (labelIntentPattern.test(inputText)) {
    return labels
  }
  return []
}

interface FieldChanges {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
}

/**
 * Collect field changes from enrichment result (overwrite mode).
 *
 * Compares the AI output against the existing task and builds SET clauses
 * for fields that should change. Overwrites existing values — this is
 * intentional for both new title-only tasks (where fields are empty anyway)
 * and re-enrichment (where the user explicitly requested it via the label).
 *
 * Labels are merged (AI labels added to existing), and `ai-to-process` is
 * always removed from the final label set.
 */
function collectEnrichmentChanges(
  task: Task,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
  inputText: string,
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

  // Due date — always overwrite
  if (enrichment.due_at) {
    if (enrichment.due_at !== task.due_at) {
      setClauses.push('due_at = ?')
      values.push(enrichment.due_at)
      fieldsChanged.push('due_at')
    }
  }

  // Priority — always overwrite
  if (enrichment.priority > 0) {
    if (enrichment.priority !== task.priority) {
      setClauses.push('priority = ?')
      values.push(enrichment.priority)
      fieldsChanged.push('priority')
    }
  }

  // Labels — filter through explicit-only guard, merge into existing, remove ai-to-process.
  // Always update labels to at least remove the trigger label.
  {
    const filteredLabels = filterExplicitLabels(enrichment.labels, inputText)
    const existingLabels = new Set(task.labels)

    // §7.2: this path used to write labels straight to SQL, bypassing the
    // registry entirely. It now registers what it adds — but only domain
    // labels. A label in the reserved `ai-` namespace is dropped unless it is
    // already registered, because those carry behavior: a typo'd `ai-monitored`
    // yields a task nobody watches that looks flagged.
    //
    // Auto-registering the rest is deliberate rather than a loophole. Anything
    // reaching here has already survived filterExplicitLabels, so it is a label
    // the *user* stated out loud, not one the AI inferred — rejecting it would
    // silently discard something they explicitly asked for.
    const creatable = filterAutoCreatableLabels(
      user.id,
      filteredLabels.filter((l) => !existingLabels.has(l)),
    )
    validateLabelsExist(user.id, creatable, [], true)

    const merged = [...task.labels, ...creatable].filter((l) => l !== 'ai-to-process')
    const labelsJson = JSON.stringify(merged)
    const currentLabelsJson = JSON.stringify(task.labels)
    if (labelsJson !== currentLabelsJson) {
      setClauses.push('labels = ?')
      values.push(labelsJson)
      fieldsChanged.push('labels')
    }
  }

  // RRULE — always overwrite
  if (enrichment.rrule) {
    if (enrichment.rrule !== task.rrule) {
      setClauses.push('rrule = ?')
      values.push(enrichment.rrule)
      fieldsChanged.push('rrule')
    }

    // Derive anchor fields from the (possibly new) rrule
    const dueAt = enrichment.due_at || task.due_at
    const anchors = deriveAnchorFields(enrichment.rrule, dueAt, user.timezone)
    setClauses.push('anchor_time = ?', 'anchor_dow = ?', 'anchor_dom = ?')
    values.push(anchors.anchor_time, anchors.anchor_dow, anchors.anchor_dom)
    fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')

    // Compute the first occurrence when there is no due date to keep — and
    // always for a reminder, whose due_at exists only to point at its next
    // occurrence. A reminder created daily-at-4pm and then enriched to Fridays
    // at 8:30 would otherwise keep pointing at today at 4pm.
    if (task.is_reminder || (!task.due_at && !enrichment.due_at)) {
      const firstOccurrence = computeFirstOccurrence(
        enrichment.rrule,
        null,
        user.timezone,
      ).toISOString()
      if (firstOccurrence !== task.due_at) {
        setClauses.push('due_at = ?')
        values.push(firstOccurrence)
        if (!fieldsChanged.includes('due_at')) fieldsChanged.push('due_at')
      }
    }
  }

  // Auto-snooze minutes — overwrite if AI extracted a value
  if (enrichment.auto_snooze_minutes !== null && enrichment.auto_snooze_minutes !== undefined) {
    if (enrichment.auto_snooze_minutes !== task.auto_snooze_minutes) {
      setClauses.push('auto_snooze_minutes = ?')
      values.push(enrichment.auto_snooze_minutes)
      fieldsChanged.push('auto_snooze_minutes')
    }
  }

  // Recurrence mode — overwrite if AI extracted a value
  if (enrichment.recurrence_mode) {
    if (enrichment.recurrence_mode !== task.recurrence_mode) {
      setClauses.push('recurrence_mode = ?')
      values.push(enrichment.recurrence_mode)
      fieldsChanged.push('recurrence_mode')
    }
  }

  // Notes — overwrite if AI extracted context/details
  if (enrichment.notes) {
    if (enrichment.notes !== task.notes) {
      setClauses.push('notes = ?')
      values.push(enrichment.notes)
      fieldsChanged.push('notes')
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
 * and logged for undo. Removes the `ai-to-process` label on success.
 */
function applyEnrichment(
  row: PendingTaskRow,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
  inputText: string,
): string[] {
  const task = getTaskById(row.id)
  if (!task) return []

  const changes = collectEnrichmentChanges(task, enrichment, user, inputText)

  if (changes.fieldsChanged.length === 0) {
    // No field changes, but still need to remove ai-to-process label
    removeLabel(row.id, 'ai-to-process')
    log.info('ai', `Task ${row.id} enriched — no changes needed`)
    return []
  }

  // Check if this is the initial enrichment of a newly created task.
  // If so, skip the undo log entry — undoing the 'create' action will
  // soft-delete the task (removing the enriched version entirely).
  // Re-enrichment (user manually adds ai-to-process) still logs normally
  // because the manual edit creates a second undo entry (count > 1).
  const db = getDb()
  const taskUndoCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM undo_log
       WHERE user_id = ?
       AND EXISTS (
         SELECT 1 FROM json_each(snapshot)
         WHERE json_extract(value, '$.task_id') = ?
       )`,
    )
    .get(user.id, row.id) as { count: number }
  const isInitialEnrichment = taskUndoCount.count === 1

  // Add updated_at to the SET clauses
  changes.setClauses.push('updated_at = ?')
  changes.values.push(nowUtc())
  changes.values.push(row.id) // for WHERE clause

  withTransaction((txDb) => {
    const sql = `UPDATE tasks SET ${changes.setClauses.join(', ')} WHERE id = ?`
    txDb.prepare(sql).run(...changes.values)

    if (!isInitialEnrichment) {
      const updatedTask = getTaskById(row.id)
      if (!updatedTask) throw new Error('Failed to retrieve enriched task')

      const changeList = changes.fieldsChanged
        .filter((f) => !['anchor_time', 'anchor_dow', 'anchor_dom'].includes(f))
        .join(', ')
      const description = `AI: Enriched ${task.is_reminder ? 'reminder' : 'task'} — set ${changeList}`

      const snapshot = createTaskSnapshot(task, updatedTask, changes.fieldsChanged)
      logAction(user.id, 'edit', description, changes.fieldsChanged, [snapshot])
    }
  })

  log.info('ai', `Task ${row.id} enriched: ${changes.fieldsChanged.join(', ')}`)

  // Return user-facing fields (filter out anchor internals) for toast description
  return changes.fieldsChanged.filter(
    (f) => !['anchor_time', 'anchor_dow', 'anchor_dom'].includes(f),
  )
}

interface PendingTaskRow {
  id: number
  user_id: number
  title: string
  original_title: string | null
  labels: string
  priority: number
  due_at: string | null
  rrule: string | null
  is_reminder: number
}
