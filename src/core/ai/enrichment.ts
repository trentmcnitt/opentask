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
 *     → Success: remove `ai-to-process`, apply enrichment, and — for a task
 *       added in the last 15 minutes — one quiet "AI finished" push
 *       (`announceEnrichmentFinished`, src/core/notifications/enrichment-notify.ts)
 *     → Failure attempt 1: keep `ai-to-process` (retry on next cycle)
 *     → Failure attempt 2: remove `ai-to-process`, add `ai-failed`, and one
 *       quiet "AI couldn't process" push — however old the task is
 *       (`announceEnrichmentFailed`, src/core/notifications/enrichment-failed-notify.ts)
 *   [Task has both `ai-locked` + `ai-to-process`] → skip (ai-locked wins),
 *     remove `ai-to-process`
 *
 * Processing guard: a task is CLAIMED before any async work (`claimTask`) —
 * an in-memory Set<number> of task IDs in flight, checked together with a
 * fresh read of the row. Both entry points claim through it. The Set lives on
 * globalThis because this module is instantiated more than once in a build
 * (see "Pipeline state" below). Resets naturally on restart.
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
import { targetTodayTime } from '@/core/tasks/task-segments'
import {
  nowUtc,
  computeFirstOccurrence,
  deriveAnchorFields,
  parseRRule,
  getDayOfWeek,
  fillRuleTime,
} from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { stampTargetSet } from '@/core/tasks/target-set'
import { getTargetContext } from '@/core/tasks/target-context'
import { resolveTarget } from '@/lib/task-segments'
import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { isAIEnabled } from './sdk'
import { buildEnrichmentUserPrompt, buildReminderEnrichmentUserPrompt } from './prompts'
import { defaultReminderSlot, listTimeSlots } from '@/core/time-slots'
import { nearestSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { parseCadence, buildSchedule } from '@/lib/reminder-rule'
import { isTracked } from '@/lib/track'
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
import { notifyEnrichmentFinished } from '@/core/notifications/enrichment-notify'
import {
  notifyEnrichmentFailed,
  releaseEnrichmentFailedNotice,
} from '@/core/notifications/enrichment-failed-notify'

// --- Pipeline state ---
//
// All mutable state lives on globalThis, for the reason warm-slot.ts
// gives: Next.js bundles instrumentation.ts (which runs the per-minute queue)
// and the API routes (which fire `enrichSingleTask` on create) separately, and
// this module is instantiated once in each — two module ids for the same file
// in the production build. With module-level state each copy had its own
// in-flight Set, so a task created a few seconds before the cron tick was
// enriched by both paths: two model calls, two ai_activity_log rows, the
// second "no changes needed" (task created 2026-09-28, seen in prod logs).
// The retry counter and circuit breaker were split the same way, which made
// MAX_ATTEMPTS and the breaker threshold per-bundle rather than per-process.

interface EnrichmentPipelineGlobals {
  /** Lock so two queue cycles never overlap */
  processing: boolean
  /** Task IDs currently being enriched, by either entry point */
  processingTasks: Set<number>
  /** Retry tracking (taskId → attempt count). Resets on restart. */
  retryCount: Map<number, number>
  circuitBreaker: CircuitBreakerState
}

interface CircuitBreakerState {
  failureTimestamps: number[]
  pausedUntil: number | null
}

const globalForPipeline = globalThis as typeof globalThis & {
  __enrichmentPipelineState?: EnrichmentPipelineGlobals
}

if (!globalForPipeline.__enrichmentPipelineState) {
  globalForPipeline.__enrichmentPipelineState = {
    processing: false,
    processingTasks: new Set<number>(),
    retryCount: new Map<number, number>(),
    circuitBreaker: { failureTimestamps: [], pausedUntil: null },
  }
}

const pipeline = globalForPipeline.__enrichmentPipelineState
const { processingTasks, retryCount, circuitBreaker } = pipeline

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
  pipeline.processing = false
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
 * On second failure, swaps `ai-to-process` → `ai-failed` — the only place that
 * label is ever written.
 *
 * Returns true when this attempt marked the task `ai-failed`, so the caller
 * announces it (`announceEnrichmentFailed`) once its own cleanup is done —
 * outside its error handling, as with the success push.
 */
function handleFailure(taskId: number): boolean {
  const attempts = (retryCount.get(taskId) ?? 0) + 1
  retryCount.set(taskId, attempts)

  if (attempts >= MAX_ATTEMPTS) {
    swapLabel(taskId, 'ai-to-process', 'ai-failed')
    retryCount.delete(taskId)
    log.warn(
      'ai',
      `Task ${taskId} enrichment failed after ${MAX_ATTEMPTS} attempts — marked ai-failed`,
    )
    return true
  }
  log.info(
    'ai',
    `Task ${taskId} enrichment failed (attempt ${attempts}/${MAX_ATTEMPTS}) — will retry`,
  )
  return false
}

/**
 * Claim a task for enrichment, or return null if it is not this caller's to do.
 *
 * The one gate both entry points go through. Synchronous from the Set check to
 * the Set add — better-sqlite3 is synchronous, so no other enrichment can run
 * in between — which makes "check, re-read, mark in flight" atomic within the
 * process. Returns null when the task is already in flight, no longer carries
 * `ai-to-process` (someone finished it), is deleted, or is `ai-locked` (in
 * which case the trigger label is removed, as before). The caller owns the
 * claim and must `processingTasks.delete(id)` in a `finally`.
 *
 * A claimed task is being enriched again, so an earlier "AI couldn't process"
 * alert for it is spent (`releaseEnrichmentFailedNotice`): if this run fails
 * for good as well, that is a new failure and the user hears about it again.
 */
function claimTask(taskId: number, userId: number): PendingTaskRow | null {
  if (processingTasks.has(taskId)) return null

  const row = getDb()
    .prepare(
      `SELECT id, user_id, title, original_title, labels, priority, due_at, rrule, is_reminder
       FROM tasks
       WHERE id = ? AND user_id = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')`,
    )
    .get(taskId, userId) as PendingTaskRow | undefined
  if (!row) return null

  const labels: string[] = JSON.parse(row.labels)
  if (labels.includes('ai-locked')) {
    removeLabel(row.id, 'ai-to-process')
    log.info('ai', `Task ${row.id} has ai-locked label, removing ai-to-process`)
    return null
  }

  processingTasks.add(taskId)
  releaseEnrichmentFailedNotice(taskId)
  return row
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
  if (pipeline.processing) return
  if (isCircuitBreakerOpen()) return

  pipeline.processing = true
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

    for (const picked of fairQueue) {
      // `picked` is from the SELECT at the top of the cycle, and every row
      // before it awaited the model. Claiming re-reads it, so a task that the
      // fire-and-forget path finished (or is still enriching) in the meantime
      // is skipped rather than enriched a second time.
      const row = claimTask(picked.id, picked.user_id)
      if (!row) {
        skipped++
        continue
      }

      let succeeded = false
      let modelRan = false
      let markedFailed = false
      try {
        const outcome = await enrichTask(row)
        const enrichedFields = outcome ?? []
        modelRan = outcome !== null
        retryCount.delete(row.id)
        processed++
        succeeded = true
        // The queue normally only refreshes tabs silently — the toast belongs to
        // the on-demand path. A reminder is the exception: it is enriched from a
        // quick add that already promised the user a slot ("Added to Evening"),
        // and when the AI moves it the surface has to say so. Whenever the warm
        // slot is unavailable the on-demand call fails and this cycle is what
        // actually does the work, so without this the explanation is simply lost.
        if (row.is_reminder === 1) emitEnrichmentComplete(row.id, row.user_id, enrichedFields)
      } catch (err) {
        log.error('ai', `Enrichment failed for task ${row.id}:`, err)
        markedFailed = handleFailure(row.id)
        failed++
        recordFailure()
      } finally {
        processingTasks.delete(row.id)
      }

      // Notify connected tabs so the AI glow stops and enriched data appears.
      // A failure only moves `ai-*` labels, which no widget reads.
      emitSyncEvent(row.user_id, { widgets: succeeded })

      // The "AI finished" push, outside the try so a push failure can never
      // count as an enrichment failure (and trip the circuit breaker).
      if (succeeded && modelRan) announceEnrichmentFinished(row.id, row.user_id)
      // The "AI couldn't process" push, for the attempt that just marked the
      // task ai-failed — same placement and reason as the one above.
      if (markedFailed) announceEnrichmentFailed(row.id, row.user_id)

      // Stop processing this cycle if the circuit breaker tripped. Checked
      // only after the failed task's sync event and push, so the task that
      // tripped it is announced like any other.
      if (!succeeded && isCircuitBreakerOpen()) break
    }

    log.info(
      'ai',
      `Queue cycle: ${processed} processed, ${failed} failed, ${skipped} skipped` +
        ` (${fairQueue.length} picked up)`,
    )
  } finally {
    pipeline.processing = false
  }
}

/** How a horizon reads in the enrichment toast ("Within weeks"). */
const HORIZON_TOAST_LABELS: Record<NonNullable<Task['horizon']>, string> = {
  days: 'Within days',
  weeks: 'Within weeks',
  months: 'Within months',
  eventually: 'Eventually',
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

  if (fieldsChanged.includes('deadline_at') && task.deadline_at) {
    parts.push(`Deadline ${formatDueTimeParts(task.deadline_at, userTimezone).relative}`)
  }

  if (fieldsChanged.includes('horizon') && task.horizon) {
    parts.push(HORIZON_TOAST_LABELS[task.horizon])
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

  const row = claimTask(taskId, userId)
  if (!row) return

  let enrichmentSucceeded = false
  let modelRan = false
  let markedFailed = false
  let enrichedFields: string[] = []
  try {
    const outcome = await enrichTask(row)
    enrichedFields = outcome ?? []
    modelRan = outcome !== null
    retryCount.delete(taskId)
    enrichmentSucceeded = true
  } catch (err) {
    log.error('ai', `On-demand enrichment failed for task ${row.id}:`, err)
    markedFailed = handleFailure(taskId)
  } finally {
    processingTasks.delete(taskId)
  }

  // Notify all connected tabs so the AI glow stops and enriched data appears.
  // A failure only moves `ai-*` labels, which no widget reads.
  emitSyncEvent(userId, { widgets: enrichmentSucceeded })

  // Tell open tabs what the AI did, so the change can be explained rather than
  // just appearing.
  if (enrichmentSucceeded) emitEnrichmentComplete(taskId, userId, enrichedFields)
  if (enrichmentSucceeded && modelRan) announceEnrichmentFinished(taskId, userId)
  if (markedFailed) announceEnrichmentFailed(taskId, userId)
}

/**
 * Fire the "AI finished" push (`notifyEnrichmentFinished`) without awaiting it.
 *
 * Called from BOTH entry points after a successful model run — never from the
 * failure path (that is `announceEnrichmentFailed`, below) and never when the
 * user's enrichment mode is off (`enrichTask` returns null: no model ran).
 * Whether it actually sends — a task added in the last 15 minutes, first time
 * only, the user's settings, not the demo user — is decided there; see the
 * header of `src/core/notifications/enrichment-notify.ts`.
 */
function announceEnrichmentFinished(taskId: number, userId: number): void {
  notifyEnrichmentFinished(taskId, userId).catch((err) => {
    log.error('ai', `Enrichment notification failed for task ${taskId}:`, err)
  })
}

/**
 * Fire the "AI couldn't process" push (`notifyEnrichmentFailed`) without
 * awaiting it.
 *
 * Called from BOTH entry points, only for the attempt whose `handleFailure`
 * marked the task `ai-failed` (the second failure; the first is retried and
 * says nothing). Whether it actually sends — the user's master notification
 * switch, not the demo user, once per failure — is decided there; see the
 * header of `src/core/notifications/enrichment-failed-notify.ts`.
 */
function announceEnrichmentFailed(taskId: number, userId: number): void {
  notifyEnrichmentFailed(taskId, userId).catch((err) => {
    log.error('ai', `Enrichment-failed notification failed for task ${taskId}:`, err)
  })
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
): { prompt: string; isReminder: boolean; slots: TimeSlot[]; defaultSlotLabel: string | null } {
  if (row.is_reminder !== 1) {
    return {
      isReminder: false,
      slots: [],
      defaultSlotLabel: null,
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

  // No time cue in the text → the user's default reminder slot (Trent,
  // 2026-09-28), the same slot the reminder was created in. Before that
  // decision it was the slot current at enrichment time.
  const slots = listTimeSlots(user.id)
  const defaultSlotLabel = defaultReminderSlot(user.id)?.label ?? null
  return {
    isReminder: true,
    slots,
    defaultSlotLabel,
    prompt: buildReminderEnrichmentUserPrompt({
      timezone: user.timezone,
      slots,
      defaultSlotLabel,
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
 *
 * Returns the user-facing fields the enrichment changed, or null when no model
 * ran because the user's enrichment mode is off (the trigger label is simply
 * removed) — which is a success for the pipeline, but not an enrichment to
 * announce.
 */
async function enrichTask(row: PendingTaskRow): Promise<string[] | null> {
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

  const { prompt, isReminder, slots, defaultSlotLabel } = buildPromptFor(
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
    return null
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

  if (isReminder) {
    parsed = sanitizeReminderEnrichment(
      pinUnnamedDay(parsed, textToEnrich, user.timezone),
      slots,
      defaultSlotLabel,
    )
  } else {
    parsed = pinUnnamedDay(
      alignTaskModelDates(
        resolveSoonTarget(
          resolveBareTime(
            resolveDateOnlyTarget(
              sanitizeTaskModelFields(parsed, textToEnrich, row.id),
              textToEnrich,
              user.timezone,
              user.morning_time,
              targetTodayTime(user.id, user.timezone),
            ),
            textToEnrich,
            user.timezone,
          ),
          textToEnrich,
          user.timezone,
        ),
        user.timezone,
      ),
      textToEnrich,
      user.timezone,
    )
  }

  parsed = toUtcTimes(parsed, user.timezone, row.id)

  return applyEnrichment(row, parsed, user, textToEnrich)
}

/**
 * Convert the model's local datetimes (due_at, deadline_at) to UTC ISO.
 *
 * The AI returns local time (no Z, no offset); Luxon resolves it in the user's
 * zone, DST included. An unparseable value becomes null rather than failing the
 * whole enrichment.
 */
function toUtcTimes(input: EnrichmentResult, timezone: string, taskId: number): EnrichmentResult {
  let parsed = input
  // The deadline arrives as local time like due_at, and converts the same way
  // — minus the BYDAY snap, which is about where a recurring target lands.
  if (parsed.deadline_at) {
    const local = parseLocalDateTime(parsed.deadline_at, timezone)
    if (!local) {
      log.warn(
        'ai',
        `Enrichment[${taskId}]: invalid deadline_at "${parsed.deadline_at}", setting to null`,
      )
    }
    parsed = { ...parsed, deadline_at: local ? local.toUTC().toISO()! : null }
  }

  // Convert due_at from local time to UTC using Luxon.
  // The AI returns local time (no Z, no offset). Luxon handles DST transitions
  // correctly for the target date, unlike naive Date() parsing.
  if (parsed.due_at) {
    let local = parseLocalDateTime(parsed.due_at, timezone)
    if (local) {
      if (parsed.rrule) {
        const snapped = snapDueAtToByday(local, parsed.rrule)
        if (snapped !== local) {
          log.warn(
            'ai',
            `Enrichment[${taskId}]: AI due_at "${parsed.due_at}" conflicts with RRULE "${parsed.rrule}" — snapped ${local.toISO()} → ${snapped.toISO()}`,
          )
          local = snapped
        }
      }
      parsed = { ...parsed, due_at: local.toUTC().toISO()! }
    } else {
      log.warn('ai', `Enrichment[${taskId}]: invalid due_at "${parsed.due_at}", setting to null`)
      parsed = { ...parsed, due_at: null }
    }
  }

  return parsed
}

/**
 * Read a model-supplied local datetime ("2026-10-17T23:59:00") in the user's
 * zone. Defensive: a Z suffix or offset the model added despite instructions is
 * stripped, so the wall-clock time it wrote is what lands. Null when invalid.
 */
function parseLocalDateTime(value: string, timezone: string): DateTime | null {
  const bare = value.replace(/Z$/i, '').replace(/[+-]\d{2}:?\d{2}$/, '')
  // Luxon is configured to THROW on an invalid DateTime (throwOnInvalid), so
  // `isValid` alone never sees a bad value: "2026/10/16 23:59" passes the
  // schema's Date.parse check but is not ISO, and used to fail the whole
  // enrichment instead of just dropping the one field.
  try {
    const local = DateTime.fromISO(bare, { zone: timezone })
    return local.isValid ? local : null
  } catch {
    return null
  }
}

/**
 * Words that state a cutoff. `deadline_at` survives only when the input has one
 * — see `sanitizeTaskModelFields`.
 *
 * "latest" covers "tomorrow 10 AM at the latest" / "latest tomorrow 10 AM"
 * (quick capture: a target today AND a cutoff). "through" counts only after a
 * validity word ("good through the 20th", "the sale runs through Sunday") —
 * bare "through" is mostly "go through the mail", which states no cutoff.
 */
const DEADLINE_CUE =
  /\b(by|before|due|deadline|deadlines|expire|expires|expired|expiring|expiry|expiration|until|till|no later than|latest|(?:good|valid|open|lasts?|runs?|only) (?:through|thru)|close|closes|closing|cut-?off|last day|ends?|runs? out)\b/i

/**
 * Words that state a pace. `horizon` survives only when the input has one. Bare
 * "today"/"tomorrow" are NOT here — they name a day (a target), not a pace;
 * "today or tomorrow" is the pace form.
 */
const PACE_CUE =
  /\b(days?|weeks?|weekend|months?|years?|eventually|someday|some day|sometime|one of these days|at some point|timeline|today or tomorrow)\b/i

/**
 * Post-parse guard for the task model's two new fields (2026-10-10) — the same
 * belt-and-suspenders stance as `filterExplicitLabels` and `filterProjectMatch`.
 *
 * The prompt says: a deadline only from a stated cutoff, a horizon only from
 * stated pace wording, never from topic (Trent's 09-28 "no inference from
 * topic" ruling, extended to these fields 10-10). Prompt wording never got
 * topic inference to zero for projects, so this enforces the floor in code:
 *
 * - `deadline_at` is dropped unless the input contains a cutoff word ("by",
 *   "before", "due", "expires", "deadline", "until", "closes"…). An AI-guessed
 *   deadline is worse than an AI-guessed date: it caps snoozing.
 * - `horizon` is dropped unless the input contains a pace word ("week",
 *   "month", "days", "eventually", "someday"…). "Fix the squeaky door" →
 *   "eventually" is exactly the inference this blocks.
 * - A recurring result (rrule set) gets neither. Task segments exclude
 *   recurring tasks, so a horizon would mean nothing, and the prompt routes a
 *   recurring cutoff into due_at ("every Friday by 5pm" → due_at Friday 5pm),
 *   as before this model existed.
 *
 * What the guard deliberately leaves to the model: whether a present cue word
 * is used as one ("drop it off before work" has "before" but is a target).
 * Exported for the quality harness, which must judge what production stores.
 */
export function sanitizeTaskModelFields(
  enrichment: EnrichmentResult,
  inputText: string,
  taskId?: number,
): EnrichmentResult {
  let { deadline_at: deadlineAt, horizon } = enrichment
  if (enrichment.rrule) {
    deadlineAt = null
    horizon = null
  }
  if (deadlineAt && !DEADLINE_CUE.test(inputText)) {
    log.info('ai', `Enrichment[${taskId ?? '-'}]: dropped deadline_at with no cutoff wording`)
    deadlineAt = null
  }
  if (horizon && !PACE_CUE.test(inputText)) {
    log.info(
      'ai',
      `Enrichment[${taskId ?? '-'}]: dropped horizon "${horizon}" with no pace wording`,
    )
    horizon = null
  }
  return { ...enrichment, deadline_at: deadlineAt, horizon }
}

/**
 * A target with a day but no time (2026-10-11). The prompt asks for a bare
 * date ("2026-10-11") when the user names a day to do it but no time of day
 * — "do it today", "text Matthew today, latest tomorrow 10 AM" — and the code
 * places it, so the result never depends on the model's sense of "now":
 *
 * - today → `targetTodayTime`, the Target today button's rule: where Snooze
 *   all goes (the next period) while that is still today, else the top of the
 *   next hour. Never "now", which would be over target the moment it lands.
 * - any other day → the user's default task time on that day (the rule the
 *   prompt already gives for "tomorrow" with no time).
 *
 * A stated time ("today at 3pm") arrives as a full datetime and is left as
 * said. A bare date of TODAY survives only when the input says "today": in
 * the quality runs the model also returned today's date for tasks that named
 * no day at all ("check the mail"), and an invented target is exactly what the
 * prompt forbids — so with no "today" in the words, the target is dropped. Runs on the model's LOCAL values, before `alignTaskModelDates` (which
 * compares the target with the deadline) and `toUtcTimes`. `todayTarget` is a
 * UTC ISO string; it is a parameter so the function stays pure — production
 * passes `targetTodayTime(userId, timezone)`, and so does the quality harness.
 */
export function resolveDateOnlyTarget(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  morningTime: string,
  todayTarget: string,
  now: Date = new Date(),
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return enrichment
  const day = DateTime.fromISO(value.trim(), { zone: timezone })
  if (!day.isValid) return { ...enrichment, due_at: null }
  const today = DateTime.fromJSDate(now).setZone(timezone)
  if (day.hasSame(today, 'day') && !TODAY_CUE.test(inputText)) {
    log.info('ai', 'Enrichment: dropped a date-only target of today with no "today" in the input')
    return { ...enrichment, due_at: null }
  }
  const local =
    day.hasSame(today, 'day') && !enrichment.rrule
      ? DateTime.fromISO(todayTarget, { zone: 'utc' }).setZone(timezone)
      : (() => {
          const [hour, minute] = (morningTime || '09:00').split(':').map(Number)
          return day.set({ hour, minute, second: 0, millisecond: 0 })
        })()
  return {
    ...enrichment,
    due_at: local.toISO({ includeOffset: false, suppressMilliseconds: true })!,
  }
}

/**
 * A clock time in the input: "8:30am", "830am", "7pm", "7 p.m.", "at 9",
 * "at 10:15", "noon", "midnight".
 */
const CLOCK_TIME =
  /\b\d{1,2}(:?\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\bat \d{1,2}(:\d{2})?\b|\b(noon|midnight)\b/i

/**
 * Words that name a day, or a part of today ("tonight", "this afternoon"):
 * with one, the model's date is the user's and a bare time is not bare.
 */
const DAY_NAMED =
  /\b(today|tonight|tomorrow|tmrw|tomm?orr?ow|yesterday|next|this|weekend|week|month|year|days?|weeks?|months?)\b|\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|nesday|sday|urday)?\b|\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\bin \d+ (minutes?|hours?|mins?|hrs?)\b|\bin an? (hour|minute)\b/i

/**
 * A TIME WITH NO DAY is its next occurrence (Trent, 2026-10-14: "Add Matthew
 * time 8:30am … It's supposed to actually be at 8:30 am this morning"): today
 * while that time is still ahead, otherwise tomorrow. The prompt says so; this
 * catches the model returning one already passed ("8:30am" said at 10 AM, given
 * today at 8:30), which would land over target the moment it is made.
 *
 * FORWARD ONLY: a target still ahead is never pulled earlier. Whether the
 * words name a day is a regex's guess, and a day it can't read — "tommorow at
 * 3pm" — is still a day: pulling the model's correct "tomorrow" back to today
 * was the first version's bug (quality run, 2026-10-14).
 *
 * Only a one-off whose input names a clock time (`CLOCK_TIME`) and no day
 * (`DAY_NAMED`) is touched, and only its DATE: the hour and minute stay the
 * model's, which read the time. A repeating task's first date is the rule's
 * business (`pinUnnamedDay`). A null target stays null: setting one here
 * would mean parsing times out of titles, where "the 7pm news" and "Matthew
 * time" can be either the task or the time to do it — the prompt decides.
 *
 * Runs on the model's LOCAL value, after `resolveDateOnlyTarget` and before
 * `alignTaskModelDates`. Pure apart from `now`; exported for the quality
 * harness and tests.
 */
export function resolveBareTime(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || enrichment.rrule) return enrichment
  if (!CLOCK_TIME.test(inputText) || DAY_NAMED.test(inputText)) return enrichment
  const local = parseLocalDateTime(value, timezone)
  if (!local) return enrichment
  const nowLocal = DateTime.fromJSDate(now).setZone(timezone)
  let next = nowLocal.set({
    hour: local.hour,
    minute: local.minute,
    second: 0,
    millisecond: 0,
  })
  if (local > nowLocal) return enrichment
  if (next <= nowLocal) next = next.plus({ days: 1 })
  log.info('ai', 'Enrichment: moved a time with no day to its next occurrence')
  return { ...enrichment, due_at: toLocalIso(next, value) }
}

/**
 * "Do it now": "right now", "immediately", or "now" as the input's last word
 * ("call the landlord now"). Not "now that the lease is signed …" (a clause,
 * not a time), and not "for now" / "until now" / "by now" / "from now", which
 * are not a time to do it either.
 */
const NOW_CUE =
  /\b(right now|immediately)\b|(?<!\b(?:for|until|till|by|from|as of)\s)\bnow\s*[.!]*\s*$/i

/**
 * "in an hour", "in 1 hour", "in 3 hours", "in two hrs" — one count of hours.
 * A range ("in an hour or two", "in 2 or 3 hours") is not one count: the
 * lookahead stops "in an hour" matching the front of "in an hour or two", and
 * "in 2 or 3 hours" never matches because a number must sit right before
 * "hour".
 */
const IN_HOURS_CUE =
  /\bin (an|a|one|two|three|four|five|six|\d{1,2}) (?:hours?|hrs?)\b(?!\s*(?:or|to|-|–))/i

/**
 * Another time or day in the words, beside a soon cue: then the cue is not the
 * whole story and `resolveSoonTarget` leaves the model's answer alone.
 * Narrower than `DAY_NAMED`, whose bare "this" / "next" would make "do this
 * now" look dated; "may", "sat" and "sun" are left out as everyday words.
 */
const SOON_BLOCKER =
  /\b(today|tonight|tomorrow|tmrw|tomm?orr?ow|weekend|morning|afternoon|evening|noon|midnight)\b|\b(this|next) (morning|afternoon|evening|week|weekend|month|year)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu|thurs?|fri)\b|\b(january|february|march|april|june|july|august|september|october|november|december)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\bin (an?|one|\d+|two|three|four|five|six) (minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/i

const HOUR_WORDS: Record<string, number> = {
  an: 1,
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
}

/** The first quarter-hour mark (:00, :15, :30, :45) at or after `t`, to the minute. */
function ceilQuarter(t: DateTime): DateTime {
  const minute = t.startOf('minute')
  const over = minute.minute % 15
  return over === 0 ? minute : minute.plus({ minutes: 15 - over })
}

/**
 * SOON TODAY (2026-10-16): the arithmetic of "now" and "in an hour", done in
 * code rather than trusted to the model.
 *
 * - "now" / "right now" / "immediately" → about 15 minutes out, rounded UP to
 *   the next quarter hour (at 2:07 → 2:30; at 2:45 → 3:00). Before this the
 *   prompt asked for the current time itself, so the task was over target the
 *   moment it was made.
 * - "in an hour" / "in N hours" → now plus N hours, rounded up to the quarter
 *   hour (at 2:07, "in an hour" → 3:15).
 *
 * A range ("in an hour or two", "in 2 or 3 hours") is the model's: the prompt
 * asks for a whole hour inside it, and either end of the range is the user's
 * — there is no single right answer for code to enforce.
 *
 * ADJUST ONLY: a null target stays null. The model decides whether "now" is a
 * time to do it (it is not in "the shop is open now"); this only fixes the
 * time it wrote, including the date near midnight. And only when the cue is
 * the ONLY time in the words: no clock time (`CLOCK_TIME`) and no day
 * (`SOON_BLOCKER`) anywhere else in the input, so an explicit time is never
 * moved. A repeating task's first date is the rule's business.
 *
 * Runs on the model's LOCAL value, after `resolveBareTime` and before
 * `alignTaskModelDates` (which drops a target that lands after the deadline).
 * Pure apart from `now`; exported for the quality harness and tests.
 */
export function resolveSoonTarget(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || enrichment.rrule) return enrichment
  const nowCue = NOW_CUE.exec(inputText)
  const hoursCue = IN_HOURS_CUE.exec(inputText)
  // Both at once ("now … in an hour") states two times: leave it to the model.
  const cue = nowCue && hoursCue ? null : (nowCue ?? hoursCue)
  if (!cue) return enrichment
  const rest = inputText.slice(0, cue.index) + ' ' + inputText.slice(cue.index + cue[0].length)
  if (CLOCK_TIME.test(rest) || SOON_BLOCKER.test(rest)) return enrichment

  const nowLocal = DateTime.fromJSDate(now).setZone(timezone)
  const hours = cue === hoursCue ? (HOUR_WORDS[cue[1].toLowerCase()] ?? Number(cue[1])) : 0
  const target =
    cue === hoursCue
      ? ceilQuarter(nowLocal.plus({ hours }))
      : ceilQuarter(nowLocal.plus({ minutes: 15 }))
  const next = toLocalIso(target, value)
  if (next === value) return enrichment
  log.info('ai', `Enrichment: set a "${cue[0].trim()}" target to ${next}`)
  return { ...enrichment, due_at: next }
}

/**
 * Words that name a weekday ("every other Friday", "biweekly on weds", "every
 * 2 weeks on the weekend"). With one, the model's BYDAY is the user's.
 */
const WEEKDAY_NAMED =
  /\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|days|nesday|nesdays|sday|sdays|urday|urdays)?\b|\bweekdays?\b|\bweekends?\b/i

/**
 * Words that name a day of the month ("the 15th", "on the 1st", "first of the
 * month", "end of the month", "mid-month", "payday"). With one, the model's
 * BYMONTHDAY is the user's.
 */
const MONTHDAY_NAMED =
  /\b\d{1,2}(st|nd|rd|th)\b|\bthe \d{1,2}\b|\b(first|second|third|fourth|fifth|last|end|beginning|start|middle|mid|half)\b|\bmid-month\b/i

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

/**
 * Words that say when a repeat STARTS ("starting tomorrow", "from next week",
 * "this Friday", "in November"). With one, the model's first date (due_at) is
 * the user's, and the unnamed day is that date's.
 */
const START_CUE =
  /\b(today|tonight|tomorrow|next|starting|starts?|beginning|from|jan|january|feb|february|mar|march|apr|april|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i

/** Month names (and their short forms) — a yearly rule's month is the user's. */
const MONTH_WORD =
  '(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)'
const MONTH_NAMED = new RegExp(`\\b${MONTH_WORD}\\b`, 'i')

/**
 * A day of the month written next to a month ("March 15", "Mar. 15", "15
 * March", "15th of March") or as a numeric date ("3/15"). Only a numeral
 * beside a month name counts, so "every year in March at 10am" names no day.
 * Used with MONTHDAY_NAMED ("the 15th", "end of", "mid-") for yearly rules.
 */
const YEARLY_DAY_NAMED = new RegExp(
  `\\b${MONTH_WORD}\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}\\b|\\b\\d{1,2}/\\d{1,2}\\b`,
  'i',
)

/**
 * A yearly rule that names a month but no day starts on the 1st (Trent,
 * 2026-10-13): "every year in March" is March 1st, never March <today's date>.
 * Today's date is for the OPEN rules only (weekly with no day, monthly or
 * quarterly with no date — `unnamedDayPart`).
 *
 * Applies to FREQ=YEARLY with BYMONTH, when the input names a month and no day
 * of the month (nor a weekday, as in "the first Monday of March"), whatever
 * day the model gave: BYMONTHDAY becomes 1 and any BYDAY/BYSETPOS goes. The
 * model's due_at is dropped and its time folded into BYHOUR/BYMINUTE, so the
 * first occurrence is the next 1st of that month (a due_at on March 13 would
 * otherwise be the first occurrence). Several months ("March and September")
 * all start on the 1st.
 *
 * "Every year" with no month named is left as the model wrote it: a bare
 * FREQ=YEARLY floats from the creation day (the anniversary of today, like the
 * open weekly and monthly rules), and a BYMONTH the model filled in from today
 * is not the user's month, so it is not moved to the 1st.
 */
function pinYearlyFirstOfMonth(
  enrichment: EnrichmentResult,
  parts: string[],
  inputText: string,
  timezone: string,
): EnrichmentResult {
  const get = (key: string) =>
    parts.find((p) => p.toUpperCase().startsWith(`${key}=`))?.split('=')[1]
  if (
    !get('BYMONTH') ||
    !MONTH_NAMED.test(inputText) ||
    MONTHDAY_NAMED.test(inputText) ||
    YEARLY_DAY_NAMED.test(inputText) ||
    WEEKDAY_NAMED.test(inputText)
  ) {
    return enrichment
  }
  let out = parts.filter((p) => !/^(BYMONTHDAY|BYDAY|BYSETPOS)=/i.test(p))
  out.push('BYMONTHDAY=1')
  const due = enrichment.due_at ? parseLocalDateTime(enrichment.due_at, timezone) : null
  if (due && !out.some((p) => /^BYHOUR=/i.test(p))) {
    out = out.filter((p) => !/^BYMINUTE=/i.test(p))
    out.push(`BYHOUR=${due.hour}`, `BYMINUTE=${due.minute}`)
  }
  const rrule = out.join(';')
  if (rrule === enrichment.rrule && enrichment.due_at === null) return enrichment
  return { ...enrichment, rrule, due_at: null }
}

/** Which part of a rule `pinUnnamedDay` would pin, or null when none. */
function unnamedDayPart(parts: string[], inputText: string): 'BYDAY' | 'BYMONTHDAY' | null {
  const get = (key: string) =>
    parts.find((p) => p.toUpperCase().startsWith(`${key}=`))?.split('=')[1]
  const freq = get('FREQ')?.toUpperCase()
  if (freq === 'WEEKLY' && !WEEKDAY_NAMED.test(inputText)) {
    return /^[A-Z]{2}$/i.test(get('BYDAY') ?? '') ? 'BYDAY' : null
  }
  if (freq === 'MONTHLY' && !MONTHDAY_NAMED.test(inputText)) {
    const single = /^-?\d{1,2}$/.test(get('BYMONTHDAY') ?? '')
    return single && !get('BYDAY') && !get('BYSETPOS') ? 'BYMONTHDAY' : null
  }
  return null
}

/**
 * A repeat with no day named starts from today (Trent, 2026-10-12). "Every 2
 * weeks" / "every other week" / "biweekly" said on a Thursday is every other
 * THURSDAY (BYDAY=TH), and "every month" / "every quarter" / "every 3 months"
 * said on the 12th repeats on the 12th — the creation day is day 0, as for a
 * floating rule (docs/TASK-MODEL.md § Recurrence Model). The prompt used to
 * teach BYDAY=MO and BYMONTHDAY=1 for these; it now asks for today, and this
 * makes it so whatever the model answered:
 *
 * - a WEEKLY rule with exactly one plain BYDAY, when the input names no
 *   weekday, and a MONTHLY rule with exactly one BYMONTHDAY (no BYDAY or
 *   BYSETPOS), when the input names no day of the month, are pinned to the
 *   day the repeat starts: TODAY in the user's zone — or, when the input says
 *   when it starts ("every 2 weeks starting tomorrow"), the model's due_at.
 * - With no start named, a due_at the model added (a time, or a guessed first
 *   day) is folded into the rule — its time becomes BYHOUR/BYMINUTE — and
 *   dropped, so the first occurrence is the creation day's (or, if that time
 *   has passed, the next on the grid) and never a guessed Monday.
 * - The last day of a month becomes BYMONTHDAY=-1 (the last day), so a rule
 *   made on Oct 31 does not skip every shorter month. A 29th or 30th that is
 *   not the month's last day stays as is: rrule skips the months without it.
 *
 * A YEARLY rule is the exception: one that names a month but no day starts
 * on the 1st, never today's date (`pinYearlyFirstOfMonth`, 2026-10-13).
 *
 * Several days ("twice a week" → TU,TH), a stated day, and every other
 * frequency are left as the model wrote them. Runs on the model's LOCAL
 * due_at, before `toUtcTimes`. Reminders too: their prompt has no clock, so
 * the model cannot know today (their due_at is always null). Exported for the
 * quality harness, which must judge what production stores.
 */
export function pinUnnamedDay(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  if (!enrichment.rrule) return enrichment
  let parts = enrichment.rrule.split(';')
  if (parts.some((p) => /^FREQ=YEARLY$/i.test(p))) {
    return pinYearlyFirstOfMonth(enrichment, parts, inputText, timezone)
  }
  const part = unnamedDayPart(parts, inputText)
  if (!part) return enrichment

  const due = enrichment.due_at ? parseLocalDateTime(enrichment.due_at, timezone) : null
  const keepDue = due !== null && START_CUE.test(inputText)
  const day = keepDue ? due : DateTime.fromJSDate(now).setZone(timezone)
  const pinned =
    part === 'BYDAY'
      ? RRULE_DAYS[day.weekday - 1]
      : day.day === day.daysInMonth && day.day > 28
        ? '-1'
        : String(day.day)
  parts = parts.map((p) => (p.toUpperCase().startsWith(`${part}=`) ? `${part}=${pinned}` : p))
  if (due && !keepDue && !parts.some((p) => /^BYHOUR=/i.test(p))) {
    parts = parts.filter((p) => !/^BYMINUTE=/i.test(p))
    parts.push(`BYHOUR=${due.hour}`, `BYMINUTE=${due.minute}`)
  }
  return { ...enrichment, rrule: parts.join(';'), due_at: keepDue ? enrichment.due_at : null }
}

/** The word that licenses a date-only target of today (`resolveDateOnlyTarget`). */
const TODAY_CUE = /\btoday\b/i

/** A date further in the past than this is a wrong year, not a missed date. */
const STALE_DATE_DAYS = 7

/**
 * A model-supplied local datetime more than STALE_DATE_DAYS in the past, moved
 * forward a year at a time (twice at most). Returns the (possibly unchanged)
 * DateTime, or null when the value does not parse.
 */
function rollStaleYear(value: string, timezone: string, now: Date): DateTime | null {
  let local = parseLocalDateTime(value, timezone)
  if (!local) return null
  const staleBefore = DateTime.fromJSDate(now).minus({ days: STALE_DATE_DAYS })
  for (let i = 0; i < 2 && local < staleBefore; i++) local = local.plus({ years: 1 })
  return local
}

function toLocalIso(local: DateTime | null, fallback: string | null): string | null {
  if (!local) return fallback
  return local.toISO({ includeOffset: false, suppressMilliseconds: true }) ?? fallback
}

/**
 * Date sanity for the model's (still local) target and deadline — mistakes the
 * prompt forbids but the model still made in the quality runs:
 *
 * - A month and day with no year in the past ("the deadline is February 28th"
 *   said in October; "every year on March 1st" given March 1st of THIS year)
 *   came back already passed. A deadline, or a RECURRING task's first date,
 *   more than STALE_DATE_DAYS in the past is moved forward a year (twice at
 *   most) — on a fresh task that is a year slip, and a yearly or quarterly rule
 *   still lands on an occurrence a whole year on. A one-off target is not
 *   touched (unchanged behaviour). One that passed days ago ("it expired Monday") is left as
 *   said.
 * - A target after the deadline ("closes at 9pm tonight" with a made-up 10pm
 *   target). The deadline is what the user stated, so the target goes; with no
 *   target the deadline's own lead-time nag takes over.
 *
 * Pure apart from `now`; exported for the quality harness and tests.
 */
export function alignTaskModelDates(
  enrichment: EnrichmentResult,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  const deadline = enrichment.deadline_at
    ? rollStaleYear(enrichment.deadline_at, timezone, now)
    : null
  // A one-off target is left as the model wrote it (only the deadline check
  // below applies); a recurring task's FIRST date is rolled, since a past one
  // makes the whole series overdue on creation.
  const target = !enrichment.due_at
    ? null
    : enrichment.rrule
      ? rollStaleYear(enrichment.due_at, timezone, now)
      : parseLocalDateTime(enrichment.due_at, timezone)
  const targetAfterDeadline = target !== null && deadline !== null && target > deadline
  return {
    ...enrichment,
    deadline_at: toLocalIso(deadline, enrichment.deadline_at),
    due_at: targetAfterDeadline ? null : toLocalIso(target, enrichment.due_at),
  }
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
export function sanitizeReminderEnrichment(
  enrichment: EnrichmentResult,
  slots: TimeSlot[],
  defaultSlotLabel: string | null,
): EnrichmentResult {
  // Everything a reminder does not carry, cleared regardless of what came back.
  const base: EnrichmentResult = {
    ...enrichment,
    due_at: null,
    deadline_at: null,
    horizon: null,
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
  // the model said nothing about when, so the user's DEFAULT reminder slot is
  // the answer (Trent, 2026-09-28; `defaultReminderSlot`). A label that
  // matches none of the slots falls back to the first period of the day, the
  // same fallback `resolvePromptSlot` uses, so quotas and reminders agree.
  const slot =
    stated === null
      ? (slots.find((s) => s.label === defaultSlotLabel) ?? slots[0])
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
/**
 * Post-parse guard for project assignment — the project counterpart of
 * `filterExplicitLabels` below.
 *
 * The prompt sets a project in two cases (Trent, 2026-09-28): the user assigns
 * one ("add it to Work", "put it in shopping"), or the task text contains a
 * project's full name used as that name ("test task for job search" → Job
 * Search). Never from topic. Once name matches were allowed, the model began
 * filing tasks by topic again ("fix the leak in the kitchen" → Home, "pick up
 * bananas" → Shopping List, "apply to Acme" → Job Search) — its reasoning
 * often said null, but `project_name` is emitted before `reasoning`, so the
 * field was already set. Prompt wording did not get that to zero; this does.
 *
 * Division of labor. This guard is necessary, not sufficient: it keeps the
 * model's project only if at least one word of the project's name (3+
 * letters) appears in the input as a whole word. That admits every legitimate
 * case, including explicit partial names ("put it in shopping" → Shopping
 * List), and rejects every topic-only one, since topic inference is by
 * definition a match on words that are NOT the name. Whole-word matching also
 * rejects "homework" for Home or Work. What it deliberately leaves to the
 * model is whether a present word is used AS the name: "after work", "work
 * out", "on the way home" contain the word, and the prompt tells the model
 * those are not matches.
 *
 * Known cost: an explicit assignment by synonym ("put this in groceries" for a
 * project named Shopping List) is dropped.
 */
export function filterProjectMatch(projectName: string | null, inputText: string): string | null {
  if (!projectName) return null
  return projectNameWordIn(projectName, inputText) ? projectName : null
}

/**
 * True when at least one word of `projectName` appears in `text` as a whole
 * word. Short words ("of", "to") would match almost anything, so only words of
 * 3+ letters count — unless the name has nothing longer ("HR").
 */
function projectNameWordIn(projectName: string, text: string): boolean {
  const all = projectName
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const long = all.filter((w) => w.length >= 3)
  const words = long.length > 0 ? long : all
  const lower = text.toLowerCase()
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u').test(lower))
}

/**
 * May enrichment move this task into the project the model chose?
 *
 * A name match never moves a task out of a project the user chose (Trent,
 * 2026-09-28). A task in the Inbox has no chosen project, so both triggers —
 * explicit instruction and name match — apply as usual. A task already in any
 * other project moves only on an EXPLICIT instruction.
 *
 * The two are told apart by the prompt's own contract: an explicit instruction
 * is removed from the title ("update my resume put it in job search" →
 * "Update my resume"), while a name match leaves the name in the title ("Test
 * task for job search" stays as is). So for a task outside the Inbox, the move
 * is kept only if NONE of the chosen project's name words (the same whole-word
 * test as filterProjectMatch) remain in the enriched title.
 */
export function allowProjectMove(params: {
  currentIsInbox: boolean
  projectName: string
  enrichedTitle: string
}): boolean {
  if (params.currentIsInbox) return true
  return !projectNameWordIn(params.projectName, params.enrichedTitle)
}

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
 *
 * §5: on a QUOTA, everything schedule-shaped is skipped — a quota has no due
 * date and its rrule is a bare period rule that names the period it counts
 * within, not a day to occur on. These clauses are raw SQL, so they bypass the
 * guards in `collectFieldChanges` entirely. Two ways in: a user re-enriches a
 * quota by adding `ai-to-process`, or an enrichment is already in flight when
 * the task is converted into a quota. `task` here is the re-read from
 * `applyEnrichment`, so this sees the row's state at write time rather than at
 * dispatch time. Labels, priority, title and notes still apply — those mean the
 * same thing on a quota.
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

  // §5: a quota has no due date, no schedule to derive and no recurrence mode.
  const tracked = isTracked(task)

  // Due date — always overwrite. Written once, at the end, after the target
  // model has had its say (`collectEnrichmentTarget`).
  let proposedDue: string | undefined
  if (!tracked && enrichment.due_at && enrichment.due_at !== task.due_at) {
    proposedDue = enrichment.due_at
  }

  collectTaskModelEnrichment(task, enrichment, tracked, { setClauses, values, fieldsChanged })

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
  if (!tracked && enrichment.rrule) {
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
      if (firstOccurrence !== task.due_at) proposedDue = firstOccurrence
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
  if (!tracked && enrichment.recurrence_mode) {
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

  const projectId = resolveProjectChange(task, enrichment, user.id, inputText)
  if (projectId !== null) {
    setClauses.push('project_id = ?')
    values.push(projectId)
    fieldsChanged.push('project_id')
  }

  const write = { setClauses, values, fieldsChanged }
  collectEnrichmentTarget(task, enrichment, { tracked, proposedDue, userId: user.id }, write)

  // Upcoming (2026-10-12): a target or deadline the AI set restarts the wait
  // its heads-ups count over, like any other target write. The snapshot is
  // taken from the re-read row, so it carries the stamp.
  stampTargetSet(write, task, nowUtc())
  return write
}

/**
 * The target model on an enrichment write (§6 / §8, 2026-10-12). These clauses
 * are raw SQL and do not pass through `collectFieldChanges`, so they ask the
 * same `resolveTarget`: a deadline the AI found on a task with no target gets
 * the stored AUTOMATIC target ("by Friday" → deadline Friday, target auto,
 * a few days before); a target the AI set (from explicit day or time wording)
 * is a picked one, never after the deadline. A repeating task's date the AI
 * set is its scheduled occurrence too.
 */
function collectEnrichmentTarget(
  task: Task,
  enrichment: EnrichmentResult,
  opts: { tracked: boolean; proposedDue: string | undefined; userId: number },
  changes: FieldChanges,
): void {
  const rrule = changes.fieldsChanged.includes('rrule') ? enrichment.rrule : task.rrule
  const deadlineAt = changes.fieldsChanged.includes('deadline_at')
    ? (enrichment.deadline_at ?? null)
    : task.deadline_at
  const resolved = resolveTarget(
    {
      dueAt: opts.proposedDue ?? task.due_at,
      dueWritten: opts.proposedDue !== undefined,
      wasAuto: task.target_auto,
      deadlineAt,
      deadlineChanged: deadlineAt !== task.deadline_at,
      autoEligible: !rrule && !task.is_reminder && !opts.tracked,
    },
    getTargetContext(opts.userId),
  )
  if (resolved.dueAt !== task.due_at) {
    changes.setClauses.push('due_at = ?')
    changes.values.push(resolved.dueAt)
    changes.fieldsChanged.push('due_at')
  }
  if (resolved.auto !== task.target_auto) {
    changes.setClauses.push('target_auto = ?')
    changes.values.push(resolved.auto ? 1 : 0)
    changes.fieldsChanged.push('target_auto')
  }
  // A repeating task's date set here is its occurrence (a schedule, not a move).
  const occurrenceAt = rrule && !opts.tracked && opts.proposedDue ? opts.proposedDue : undefined
  if (occurrenceAt !== undefined && occurrenceAt !== task.occurrence_at) {
    changes.setClauses.push('occurrence_at = ?')
    changes.values.push(occurrenceAt)
    changes.fieldsChanged.push('occurrence_at')
  }
}

/**
 * Deadline and horizon (2026-10-10, docs/TASK-MODEL.md § Deadline, target,
 * horizon). Set-only, like due_at: a null from the model never clears what the
 * task already has. Neither applies to a quota (§5), a reminder (§6), or a
 * recurring task — the sanitizers already null them for a recurring or
 * reminder RESULT; this covers a task that was already one of those at write
 * time. A horizon restarts its clock (`horizon_set_at`), as
 * `collectTaskModelFields` does for an API edit — these clauses are raw SQL and
 * do not pass through it.
 */
function collectTaskModelEnrichment(
  task: Task,
  enrichment: EnrichmentResult,
  tracked: boolean,
  changes: FieldChanges,
): void {
  if (tracked || task.is_reminder || task.rrule || enrichment.rrule) return

  if (enrichment.deadline_at && enrichment.deadline_at !== task.deadline_at) {
    changes.setClauses.push('deadline_at = ?')
    changes.values.push(enrichment.deadline_at)
    changes.fieldsChanged.push('deadline_at')
  }

  if (enrichment.horizon && enrichment.horizon !== task.horizon) {
    changes.setClauses.push('horizon = ?', 'horizon_set_at = ?')
    changes.values.push(enrichment.horizon, nowUtc())
    changes.fieldsChanged.push('horizon', 'horizon_set_at')
  }
}

/**
 * The project enrichment should move the task into, or null to leave it.
 *
 * Resolves the model's project name (owned or shared) after two guards: the
 * text-presence guard (filterProjectMatch), and the rule that a name match
 * never moves a task out of a project the user chose (allowProjectMove). The
 * Inbox is the user's own project named "Inbox" — how createTask finds it.
 */
function resolveProjectChange(
  task: Task,
  enrichment: EnrichmentResult,
  userId: number,
  inputText: string,
): number | null {
  const projectName = filterProjectMatch(enrichment.project_name, inputText)
  if (!projectName) return null

  const db = getDb()
  const project = db
    .prepare(
      'SELECT id FROM projects WHERE (owner_id = ? OR shared = 1) AND name = ? COLLATE NOCASE',
    )
    .get(userId, projectName) as { id: number } | undefined
  if (!project || project.id === task.project_id) return null

  const current = db
    .prepare('SELECT owner_id, name FROM projects WHERE id = ?')
    .get(task.project_id) as { owner_id: number; name: string } | undefined
  const currentIsInbox = current?.owner_id === userId && current.name === 'Inbox'
  const enrichedTitle = enrichment.title || task.title
  if (!allowProjectMove({ currentIsInbox, projectName, enrichedTitle })) {
    log.info(
      'ai',
      `Task ${task.id}: kept its project — "${projectName}" came from a name match, not an instruction`,
    )
    return null
  }
  return project.id
}

/** Bookkeeping columns that ride along with a change but are not news to the user. */
const INTERNAL_FIELDS = [
  'anchor_time',
  'anchor_dow',
  'anchor_dom',
  'horizon_set_at',
  'target_set_at',
]

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

  const changes = collectEnrichmentChanges(
    task,
    withEnrichmentRuleTime(task, enrichment, user),
    user,
    inputText,
  )

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
        .filter((f) => !INTERNAL_FIELDS.includes(f))
        .join(', ')
      const description = `AI: Enriched ${task.is_reminder ? 'reminder' : 'task'} — set ${changeList}`

      const snapshot = createTaskSnapshot(task, updatedTask, changes.fieldsChanged)
      logAction(user.id, 'edit', description, changes.fieldsChanged, [snapshot])
    }
  })

  log.info('ai', `Task ${row.id} enriched: ${changes.fieldsChanged.join(', ')}`)

  // Return user-facing fields (filter out anchor internals) for toast description
  return changes.fieldsChanged.filter((f) => !INTERNAL_FIELDS.includes(f))
}

/**
 * Every non-quota rule has a time of day (2026-10-12, `fillRuleTime` in
 * `src/core/recurrence/rule-time.ts`). The task prompt keeps a rule bare and
 * puts the time in due_at ("every Monday at 9am" → `FREQ=WEEKLY;BYDAY=MO`,
 * due_at Monday 9:00), so the rule takes that date's time; with no date, the
 * task's anchor, its current date's time, else the user's Morning time. A
 * reminder's rule is already timed (`sanitizeReminderEnrichment`). The quota
 * test is the row's at write time — `task` is the re-read in `applyEnrichment`,
 * as `collectEnrichmentChanges` asks it. `enrichment.due_at` is UTC by now.
 */
function withEnrichmentRuleTime(
  task: Task,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
): EnrichmentResult {
  const rrule = fillRuleTime(enrichment.rrule, isTracked(task), {
    requestDueAt: enrichment.due_at,
    anchorTime: task.anchor_time,
    existingDueAt: task.due_at,
    morningTime: getTargetContext(user.id).morningTime,
    timezone: user.timezone,
  })
  return rrule === enrichment.rrule ? enrichment : { ...enrichment, rrule }
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
