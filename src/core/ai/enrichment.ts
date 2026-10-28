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
 *     → Slot unavailable (`SlotUnavailableError`: the warm slot dead or not
 *       started, the task never sent): keep `ai-to-process`, spend no
 *       attempt, and wait for the slot — up to SLOT_WAIT_LIMIT_MS, then
 *       `ai-failed` as below (2026-10-28)
 *     → Failure attempt 1: keep `ai-to-process` (retry on next cycle)
 *     → Failure attempt 2: remove `ai-to-process`, add `ai-failed`, and one
 *       quiet "AI failed to process" push — however old the task is
 *       (`announceEnrichmentFailed`, src/core/notifications/enrichment-failed-notify.ts)
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
  bydayDows,
  normalizeRRule,
  ordinalsCount,
  computeNextOccurrence,
  getDayOfWeek,
  fillRuleTime,
  rollPassedFirstOccurrence,
} from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { runAsSystem } from '@/core/request-context'
import { stampTargetSet } from '@/core/tasks/target-set'
import { collectDeckClear } from '@/core/tasks/deck-clear'
import { getTargetContext } from '@/core/tasks/target-context'
import { getAnchorTimes } from '@/core/users/anchor-times'
import { linkTargetTime, type LinkInput } from '@/core/tasks/relative-target'
import { ValidationError } from '@/core/errors'
import {
  CHECK_IN_DAY_DEFAULT,
  coerceCheckInDay,
  deckDayProblem,
  deckDayWords,
  deckSkip,
  hasPickedTarget,
  leadFor,
  relativeOf,
  relativeOneOffProblem,
  resolveTarget,
  type CheckInDay,
  type RelativeTarget,
} from '@/lib/task-segments'
import { isLateNight, openTaskDayOf, openTaskLocalDay } from '@/lib/opentask-day'
import { dayBoundaryForUser, rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { isAIEnabled } from './sdk'
import {
  buildEnrichmentUserPrompt,
  buildQuotaEnrichmentUserPrompt,
  buildReminderEnrichmentUserPrompt,
} from './prompts'
import { defaultReminderSlot, listTimeSlots } from '@/core/time-slots'
import { nearestSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { parseCadence, buildSchedule } from '@/lib/reminder-rule'
import { isTracked } from '@/lib/track'
import { EnrichmentResultSchema } from './types'
import { stripRepeatPhrase } from './repeat-title'
import { RELATIVE_CUE, relativeTargetTime, type RelativeTimeContext } from './relative-wording'
import { filterExplicitLabels } from './explicit-labels'
import {
  postProcessQuotaEnrichment,
  quotaCadenceWords,
  quotaPromptConfigFor,
  quotaPromptWords,
  withoutQuotaFields,
  type QuotaEnrichmentPlan,
} from './quota-enrichment'
import { applyFieldChanges, collectFieldChanges, settleQuotaPeriod } from '@/core/tasks/helpers'
import type { FieldChangesInput } from '@/core/tasks/helpers/collect-field-changes'
import type { EnrichmentResult } from './types'
import { enrichmentQuery } from './enrichment-slot'
import { SlotUnavailableError } from './slot-shared'
import { enrichmentApiQuery } from './enrichment-api'
import { resolveFeatureAIConfig } from './models'
import { getUserFeatureModes, resolveFeatureTimeout } from './user-context'
import { DateTime } from 'luxon'
import { emitSyncEvent, emitEnrichmentCompleteEvent } from '@/lib/sync-events'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRule } from '@/lib/format-rrule'
import { relativeTargetWords } from '@/lib/editor-target-labels'
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
  /** When each task first found the slot unavailable (taskId → ms). Resets on restart. */
  slotWaitSince: Map<number, number>
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
    slotWaitSince: new Map<number, number>(),
    circuitBreaker: { failureTimestamps: [], pausedUntil: null },
  }
}

const pipeline = globalForPipeline.__enrichmentPipelineState
// A dev server's hot reload keeps the globals of the code before this field.
pipeline.slotWaitSince ??= new Map<number, number>()
const { processingTasks, retryCount, slotWaitSince, circuitBreaker } = pipeline

const MAX_ATTEMPTS = 2

/**
 * How long a task waits for an UNAVAILABLE warm slot before it is marked
 * `ai-failed` (2026-10-28). Above the slot's longest re-init backoff (10
 * minutes, `REINIT_BACKOFF_SCHEDULE_MS`), so a slot that dies and comes back
 * gets every waiting task done. Before this, a dead slot failed the on-demand
 * attempt at once and the next minute's queue retry too — both inside one
 * backoff — and five of Trent's tasks went `ai-failed` without the model ever
 * seeing them.
 */
export const SLOT_WAIT_LIMIT_MS = 30 * 60_000

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
  slotWaitSince.clear()
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
 * What became of a failed enrichment: `retry` (an attempt spent, the next
 * cycle tries again), `waiting` (the slot was unavailable — no attempt spent),
 * or `failed` (this call marked the task `ai-failed`).
 */
export type FailureOutcome = 'retry' | 'waiting' | 'failed'

/**
 * Handle enrichment failure for a task.
 *
 * An UNAVAILABLE SLOT (`SlotUnavailableError`) spends no attempt: the task
 * keeps `ai-to-process` and the queue tries it again each minute, so it is
 * done as soon as the slot is back — unless it has waited SLOT_WAIT_LIMIT_MS,
 * when it is marked `ai-failed` like any other.
 *
 * Any other error spends an attempt, tracked in memory. On the first, keeps
 * `ai-to-process` for retry; on the second, swaps `ai-to-process` →
 * `ai-failed` — with the wait limit above, the only places that label is ever
 * written.
 *
 * `failed` tells the caller to announce it (`announceEnrichmentFailed`) once
 * its own cleanup is done — outside its error handling, as with the success
 * push. The caller logs the error itself, except for `waiting`, which this
 * logs once per task.
 */
function handleFailure(taskId: number, err: unknown, now = Date.now()): FailureOutcome {
  if (err instanceof SlotUnavailableError) {
    const since = slotWaitSince.get(taskId)
    if (since === undefined) {
      slotWaitSince.set(taskId, now)
      log.info('ai', `Task ${taskId}: ${err.message} — waiting for it (no attempt spent)`)
      return 'waiting'
    }
    if (now - since < SLOT_WAIT_LIMIT_MS) return 'waiting'
    slotWaitSince.delete(taskId)
    retryCount.delete(taskId)
    swapLabel(taskId, 'ai-to-process', 'ai-failed')
    log.warn(
      'ai',
      `Task ${taskId}: the enrichment slot was unavailable for ${SLOT_WAIT_LIMIT_MS / 60_000} minutes — marked ai-failed`,
    )
    return 'failed'
  }

  const attempts = (retryCount.get(taskId) ?? 0) + 1
  retryCount.set(taskId, attempts)

  if (attempts >= MAX_ATTEMPTS) {
    swapLabel(taskId, 'ai-to-process', 'ai-failed')
    retryCount.delete(taskId)
    slotWaitSince.delete(taskId)
    log.warn(
      'ai',
      `Task ${taskId} enrichment failed after ${MAX_ATTEMPTS} attempts — marked ai-failed`,
    )
    return 'failed'
  }
  log.info(
    'ai',
    `Task ${taskId} enrichment failed (attempt ${attempts}/${MAX_ATTEMPTS}) — will retry`,
  )
  return 'retry'
}

/**
 * A queue attempt's failure: handled (`handleFailure`), and — unless the task
 * is only waiting for the slot, which never had it — logged and counted
 * towards the circuit breaker.
 */
function queueFailure(taskId: number, err: unknown): FailureOutcome {
  const result = handleFailure(taskId, err)
  if (result === 'waiting') return result
  log.error('ai', `Enrichment failed for task ${taskId}:`, err)
  recordFailure()
  return result
}

/** The queue cycle's log line: "Queue cycle: 0 processed, 1 failed, 0 skipped, 2 waiting for the slot (3 picked up)". */
function cycleSummary(
  processed: number,
  failures: Record<FailureOutcome, number>,
  skipped: number,
  pickedUp: number,
): string {
  const waiting = failures.waiting ? `, ${failures.waiting} waiting for the slot` : ''
  return (
    `Queue cycle: ${processed} processed, ${failures.retry + failures.failed} failed, ` +
    `${skipped} skipped${waiting} (${pickedUp} picked up)`
  )
}

/** A task enriched: its failure tracking goes. */
function clearFailures(taskId: number): void {
  retryCount.delete(taskId)
  slotWaitSince.delete(taskId)
}

/**
 * Claim a task for enrichment, or return null if it is not this caller's to do.
 *
 * The one gate both entry points go through. Synchronous from the Set check to
 * the Set add — better-sqlite3 is synchronous, so no other enrichment can run
 * in between — which makes "check, re-read, mark in flight" atomic within the
 * process. Returns null when the task is already in flight, no longer carries
 * `ai-to-process` (someone finished it), or is deleted. The caller owns the
 * claim and must `processingTasks.delete(id)` in a `finally`.
 *
 * A claimed task is being enriched again, so an earlier "AI failed to process"
 * alert for it is spent (`releaseEnrichmentFailedNotice`): if this run fails
 * for good as well, that is a new failure and the user hears about it again.
 */
function claimTask(taskId: number, userId: number): PendingTaskRow | null {
  if (processingTasks.has(taskId)) return null

  const row = getDb()
    .prepare(
      `SELECT id, user_id, title, original_title, labels, priority, due_at, on_deck_day, rrule, is_reminder,
              is_tracked, progress_target
       FROM tasks
       WHERE id = ? AND user_id = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')`,
    )
    .get(taskId, userId) as PendingTaskRow | undefined
  if (!row) return null

  processingTasks.add(taskId)
  releaseEnrichmentFailedNotice(taskId)
  return row
}

/**
 * Process the enrichment queue. Called by cron every minute.
 *
 * Picks up tasks with the `ai-to-process` label, processes them one at a
 * time, and applies the enrichment
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
    const pendingTasks = db
      .prepare(
        `SELECT id, user_id, title, original_title, labels, priority, due_at, on_deck_day, rrule, is_reminder,
                is_tracked, progress_target
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
    let skipped = 0
    // Failures by outcome: `waiting` is not one (`queueFailure`).
    const failures: Record<FailureOutcome, number> = { retry: 0, failed: 0, waiting: 0 }

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
        clearFailures(row.id)
        processed++
        succeeded = true
        // The queue normally only refreshes tabs silently — the toast belongs to
        // the on-demand path. A reminder is the exception: it is enriched from a
        // quick add that already promised the user a slot ("Added to Evening"),
        // and when the AI moves it the surface has to say so. Whenever the warm
        // slot is unavailable the on-demand call fails and this cycle is what
        // actually does the work, so without this the explanation is simply lost.
        // A quota likewise (2026-10-24): it was added as a provisional weekly
        // count, often by a Shortcut, and the cron is what usually finishes it.
        if (isReminderOrQuota(row)) emitEnrichmentComplete(row.id, row.user_id, enrichedFields)
      } catch (err) {
        const result = queueFailure(row.id, err)
        failures[result]++
        markedFailed = result === 'failed'
      } finally {
        processingTasks.delete(row.id)
      }

      // Notify connected tabs so the AI glow stops and enriched data appears.
      // A failure only moves `ai-*` labels, which no widget reads.
      emitSyncEvent(row.user_id, { widgets: succeeded })

      // The "AI finished" push, outside the try so a push failure can never
      // count as an enrichment failure (and trip the circuit breaker).
      if (succeeded && modelRan) announceEnrichmentFinished(row.id, row.user_id)
      // The "AI failed to process" push, for the attempt that just marked the
      // task ai-failed — same placement and reason as the one above.
      if (markedFailed) announceEnrichmentFailed(row.id, row.user_id)

      // Stop processing this cycle if the circuit breaker tripped. Checked
      // only after the failed task's sync event and push, so the task that
      // tripped it is announced like any other.
      if (!succeeded && isCircuitBreakerOpen()) break
    }

    log.info('ai', cycleSummary(processed, failures, skipped, fairQueue.length))
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
 * A relative target the AI set (2026-10-24): "the day before at 8:30 PM" — the
 * target then moves with the deadline.
 */
function relativeToastPart(task: Task, fieldsChanged: string[]): string | null {
  const relative = relativeOf(task)
  if (task.rrule || !relative || !fieldsChanged.includes('target_days_before')) return null
  return relativeTargetWords(relative.days_before, relative.time)
}

/**
 * Build a concise toast description from enrichment results.
 * Shows actual values (not field names): "Tomorrow 9:00 AM · Medium · Shopping"
 */
function buildEnrichmentDescription(
  task: Task,
  fieldsChanged: string[],
  userTimezone: string,
  /** The user's day boundary: "Tomorrow 9:00 AM" / "On deck tomorrow" by OpenTask day. */
  dayStart: string,
  projectName?: string,
): string | undefined {
  const parts: string[] = []

  // A reminder's due_at is bookkeeping for "which occurrence is next", never a
  // deadline, so saying "in 5 days" about one would be describing debt it does
  // not carry. Its schedule alone is the news.
  if (!task.is_reminder && fieldsChanged.includes('due_at') && task.due_at) {
    parts.push(formatDueTimeParts(task.due_at, userTimezone, dayStart).relative)
  }

  const relative = relativeToastPart(task, fieldsChanged)
  if (relative) parts.push(relative)

  // On deck (D3): a day with no time — "On deck tomorrow", "On deck Sat Oct 24".
  if (fieldsChanged.includes('on_deck_day') && task.on_deck_day) {
    parts.push(`On deck ${deckDayWords(task.on_deck_day, userTimezone, new Date(), dayStart)}`)
  }

  if (fieldsChanged.includes('deadline_at') && task.deadline_at) {
    parts.push(`Deadline ${formatDueTimeParts(task.deadline_at, userTimezone, dayStart).relative}`)
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
 *
 * Runs as the system (`runAsSystem`): the route only starts it, and the AI's
 * edit is not the client's — without this the request context would follow
 * the fire-and-forget promise and stamp the AI's undo entry `web` or `ios`.
 *
 * Resolves with the user-facing fields the enrichment changed, or null when
 * no model ran here (AI or the user's mode off, or another path holds the
 * task) or the run failed — what `POST /api/tasks` with `wait` describes
 * (`describeEnrichment`, 2026-10-24); the fire-and-forget caller ignores it.
 */
export function enrichSingleTask(taskId: number, userId: number): Promise<string[] | null> {
  return runAsSystem(() => enrichSingleTaskAsSystem(taskId, userId))
}

async function enrichSingleTaskAsSystem(taskId: number, userId: number): Promise<string[] | null> {
  if (!isAIEnabled()) return null

  const row = claimTask(taskId, userId)
  if (!row) return null

  let enrichmentSucceeded = false
  let modelRan = false
  let markedFailed = false
  let enrichedFields: string[] = []
  try {
    const outcome = await enrichTask(row)
    enrichedFields = outcome ?? []
    modelRan = outcome !== null
    clearFailures(taskId)
    enrichmentSucceeded = true
  } catch (err) {
    const result = handleFailure(taskId, err)
    if (result !== 'waiting')
      log.error('ai', `On-demand enrichment failed for task ${row.id}:`, err)
    markedFailed = result === 'failed'
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
  return modelRan ? enrichedFields : null
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
 * Fire the "AI failed to process" push (`notifyEnrichmentFailed`) without
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
  const described = describeEnrichment(taskId, userId, enrichedFields)
  if (!described) return
  const { task: enrichedTask, description } = described
  emitEnrichmentCompleteEvent(userId, {
    taskId,
    title: enrichedTask.title,
    description,
    due_at: enrichedTask.due_at,
    priority: enrichedTask.priority,
  })
}

/**
 * The task as enriched, and the toast's words for what the AI changed
 * (`buildEnrichmentDescription`; a quota's in `quotaEnrichmentDescription`).
 * The sync event's payload, and `POST /api/tasks` with `wait` (2026-10-24),
 * whose `ai.description` is the same string. Null when the task is gone.
 */
export function describeEnrichment(
  taskId: number,
  userId: number,
  enrichedFields: string[],
): { task: Task; description: string | undefined } | null {
  const db = getDb()
  const enrichedTask = getTaskById(taskId)
  if (!enrichedTask) return null
  if (isTracked(enrichedTask)) {
    return {
      task: enrichedTask,
      description: quotaEnrichmentDescription(enrichedTask, enrichedFields, listTimeSlots(userId)),
    }
  }

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

  return {
    task: enrichedTask,
    description: buildEnrichmentDescription(
      enrichedTask,
      enrichedFields,
      userRow?.timezone ?? 'America/Chicago',
      dayBoundaryForUser(userId),
      projectName,
    ),
  }
}

/**
 * A quota's toast (2026-10-24): "3× a week · Reminds at Midday · fitness" —
 * the count and period when either changed, the reminder setting when it did,
 * then priority and labels as for a task.
 */
function quotaEnrichmentDescription(
  task: Task,
  fieldsChanged: string[],
  slots: TimeSlot[],
): string | undefined {
  const parts: string[] = []
  if (fieldsChanged.includes('rrule') || fieldsChanged.includes('progress_target')) {
    const cadence = quotaCadenceWords(task)
    if (cadence) parts.push(cadence)
  }
  if (fieldsChanged.includes('quota_prompt_config')) {
    const prompt = quotaPromptWords(task, slots)
    if (prompt) parts.push(prompt)
  }
  if (fieldsChanged.includes('priority') && task.priority > 0) {
    parts.push(getPriorityOption(task.priority).label)
  }
  if (fieldsChanged.includes('labels')) {
    const displayLabels = task.labels.filter((l) => !l.startsWith('ai-'))
    if (displayLabels.length > 0) parts.push(displayLabels.join(', '))
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Choose and render the prompt for one pending row.
 *
 * A reminder is parsed against the user's editable time slots, not their
 * workday, and against its own instruction list — see
 * `buildReminderEnrichmentUserPrompt` for why that is a separate prompt rather
 * than a branch inside the task one. The slots come back with the prompt
 * because the sanitizer needs the same ones the model was shown — and a
 * task's prompt lists them too (2026-10-24), for a relative target's period
 * ("the evening before" → the Evening period), mapped by
 * `resolveEnrichmentRelative` against the same list.
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
  projects: Array<{ id: number; name: string; shared: number; description: string | null }>,
  textToEnrich: string,
): { prompt: string; isReminder: boolean; slots: TimeSlot[]; defaultSlotLabel: string | null } {
  const slots = listTimeSlots(user.id)
  if (row.is_reminder !== 1) {
    return {
      isReminder: false,
      slots,
      defaultSlotLabel: null,
      prompt: buildEnrichmentUserPrompt({
        timezone: user.timezone,
        morningTime: user.morning_time,
        wakeTime: user.wake_time,
        sleepTime: user.sleep_time,
        periods: slots,
        projects,
        userContext: user.ai_context,
        taskText: textToEnrich,
        dayStart: dayBoundaryForUser(user.id),
      }),
    }
  }

  // No time cue in the text → the user's default reminder slot (Trent,
  // 2026-09-28), the same slot the reminder was created in. Before that
  // decision it was the slot current at enrichment time.
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
 * The quota prompt (2026-10-24, `buildQuotaEnrichmentUserPrompt`): against
 * the user's periods, which come back with it because the post-process maps
 * the reminder period the model names onto the same list.
 */
function quotaPromptFor(
  user: { id: number; timezone: string; ai_context: string | null },
  textToEnrich: string,
): { prompt: string; isReminder: boolean; slots: TimeSlot[]; defaultSlotLabel: string | null } {
  const slots = listTimeSlots(user.id)
  return {
    isReminder: false,
    slots,
    defaultSlotLabel: null,
    prompt: buildQuotaEnrichmentUserPrompt({
      timezone: user.timezone,
      slots,
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
  const userRow = db
    .prepare('SELECT id, timezone, ai_context, check_in_day FROM users WHERE id = ?')
    .get(row.user_id) as
    | { id: number; timezone: string; ai_context: string | null; check_in_day: number }
    | undefined
  if (!userRow) {
    throw new Error(`User ${row.user_id} not found`)
  }
  // Morning, Wake and Sleep as resolved (a linked period's start, 2026-10-21).
  const anchors = getAnchorTimes(userRow.id)
  const user = {
    ...userRow,
    morning_time: anchors.morning.time,
    morning_slot_id: anchors.morning.slot_id,
    wake_time: anchors.wake.time,
    sleep_time: anchors.sleep.time,
  }

  // Available projects for project name resolution (owned + shared). The
  // description (what belongs there) lets the model choose between projects
  // the words already match — it never makes a match on its own.
  const projects = db
    .prepare(
      'SELECT id, name, shared, description FROM projects WHERE owner_id = ? OR shared = 1 ORDER BY sort_order',
    )
    .all(user.id) as { id: number; name: string; shared: number; description: string | null }[]

  // Use original_title when available (preserves raw dictated input for re-enrichment).
  // Legacy tasks with null original_title fall back to current title.
  const textToEnrich = row.original_title || row.title

  // A quota (2026-10-24) has a prompt of its own, against the user's periods.
  const quota = rowIsQuota(row)
  const { prompt, isReminder, slots, defaultSlotLabel } = quota
    ? quotaPromptFor(user, textToEnrich)
    : buildPromptFor(row, user, projects, textToEnrich)

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
    const validation = parseEnrichmentAnswer(result.structuredOutput, row.id)
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
      const validation = parseEnrichmentAnswer(json, row.id)
      if (validation.success) parsed = validation.data
    } catch {
      // Not valid JSON text
    }
  }

  if (!parsed) {
    throw new Error('Failed to parse enrichment result')
  }

  // A quota has no dates: its own post-process and its own write.
  if (quota) {
    return applyQuotaEnrichment(row, postProcessQuotaEnrichment(parsed, textToEnrich, slots), user)
  }

  if (isReminder) {
    parsed = sanitizeReminderEnrichment(
      pinUnnamedDay(parsed, textToEnrich, user.timezone, new Date(), dayBoundaryForUser(user.id)),
      slots,
      defaultSlotLabel,
    )
  } else {
    parsed = postProcessTaskEnrichment(parsed, textToEnrich, user.timezone, {
      morningTime: user.morning_time,
      todayTarget: targetTodayTime(user.id, user.timezone),
      rolloverTime: rolloverTimeForUser(user.id),
      dayStart: dayBoundaryForUser(user.id),
      checkInDay: coerceCheckInDay(user.check_in_day),
      taskId: row.id,
      // A new task: created title-only (createTask's `isTitleOnly`), so no
      // date or rule yet. Re-enriching one that has either is an edit.
      newTask: row.due_at === null && row.rrule === null,
      // A relative target's time: the periods the prompt listed, and the
      // Default task time as it is (linked or custom, ruling 10).
      relative: {
        slots,
        defaultTime: { time: user.morning_time, slot_id: user.morning_slot_id },
      },
    })
  }

  parsed = toUtcTimes(parsed, user.timezone, row.id)

  return applyEnrichment(row, parsed, user, textToEnrich)
}

export interface PostProcessOptions {
  morningTime: string
  todayTarget: string
  /** The user's rollover (HH:MM, `rolloverTimeForUser`) — A4 in `resolveDeckDay`. */
  rolloverTime?: string
  /**
   * The user's day boundary (HH:MM, `dayBoundaryForUser`): the OpenTask day a
   * repeat with no day named is pinned to (`pinUnnamedDay`), "this weekend"
   * is read on, and a passed first date rolls on from.
   */
  dayStart: string
  /** The user's check-in day — a bare "this weekend" in `resolveDeckDay`. */
  checkInDay?: CheckInDay
  taskId?: number
  now?: Date
  /**
   * The enrichment of a NEW task — created title-only, with no date or rule
   * yet. Only then does a repeat's past first date roll to its next
   * occurrence (`rollPassedRepeatStart`); a re-enrichment of an existing task
   * never moves its dates that way. Default false.
   */
  newTask?: boolean
  /**
   * Relative targets (2026-10-24): the owner's periods and their Default task
   * time as stored, for `resolveEnrichmentRelative`. Absent: no periods, and
   * the Default task time is `morningTime`, custom.
   */
  relative?: RelativeTimeContext
}

/**
 * Every date post-process a (non-reminder) task's enrichment goes through, in
 * order, on the model's LOCAL values. Production (SDK and API mode alike) and
 * the quality harness both call this, so the two cannot drift:
 * deadline/horizon guard → a day with no time on deck (else the date-only
 * target, `resolveDeckDay`) → bare time → soon today →
 * "now that" drop → "today" on today's local date → A4's "tomorrow" before
 * the rollover → same-day past /
 * "tomorrow" → unstated past dates →
 * deadline alignment → unnamed-day pin → a repeat's passed start rolled on →
 * a relative target's time and period (`resolveEnrichmentRelative`).
 */
export function postProcessTaskDates(
  parsed: EnrichmentResult,
  inputText: string,
  timezone: string,
  opts: PostProcessOptions,
): EnrichmentResult {
  const now = opts.now ?? new Date()
  let result = sanitizeTaskModelFields(parsed, inputText, opts.taskId)
  result = resolveDeckDay(result, inputText, timezone, opts, now)
  result = resolveBareTime(result, inputText, timezone, now)
  result = resolveSoonTarget(result, inputText, timezone, now)
  result = dropNowPhraseTarget(result, inputText, timezone, now)
  result = resolveTodayLocalDate(result, inputText, timezone, opts.todayTarget, now)
  result = resolveEarlyTomorrow(result, inputText, timezone, opts.rolloverTime, now)
  result = resolveSameDayPast(result, inputText, timezone, now, opts.rolloverTime)
  result = dropUnstatedPastDates(result, inputText, timezone, now)
  result = alignTaskModelDates(result, timezone, now)
  result = pinUnnamedDay(result, inputText, timezone, now, opts.dayStart)
  if (opts.newTask) result = rollPassedRepeatStart(result, timezone, now, opts.dayStart)
  const relativeCtx = opts.relative ?? {
    slots: [],
    defaultTime: { time: opts.morningTime, slot_id: null },
  }
  return resolveEnrichmentRelative(result, inputText, relativeCtx, opts.taskId)
}

/**
 * The whole deterministic post-process of a (non-reminder) task's enrichment:
 * the date rules (`postProcessTaskDates`), then a repeat phrase left at the
 * start or end of the title that says exactly what the rule says is removed
 * (`stripRepeatPhrase`, 2026-10-16: "Water the ferns every other day" →
 * "Water the ferns"). Production and the quality harness both call this.
 */
export function postProcessTaskEnrichment(
  parsed: EnrichmentResult,
  inputText: string,
  timezone: string,
  opts: PostProcessOptions,
): EnrichmentResult {
  // A task never uses the quota fields (quota enrichment, 2026-10-24).
  const result = withoutQuotaFields(
    postProcessTaskDates(withNormalizedRule(parsed), inputText, timezone, opts),
  )
  const title = stripRepeatPhrase(result.title, result.rrule)
  if (title === result.title) return result
  log.info('ai', 'Enrichment: removed a repeat phrase from the title that the rule already says')
  return { ...result, title }
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
 * - RELATIVE TARGETS (2026-10-24, ruling 9: only relative wording makes a
 *   target relative): `target_days_before` / `target_time` / `target_period`
 *   are dropped unless the input counts back from a deadline
 *   (`RELATIVE_CUE`: "the evening before", "2 days before", "the morning
 *   of"), the result keeps a deadline, and it has no rule. When they
 *   survive, the target is theirs: `due_at` and the deck day are dropped
 *   (the target is derived from the deadline when it is written). A
 *   reminder never gets here — `sanitizeReminderEnrichment` nulls them.
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
  return sanitizeRelativeOffsets(
    { ...enrichment, deadline_at: deadlineAt, horizon },
    inputText,
    taskId,
  )
}

/** The model's relative-target fields, all null. */
const NO_RELATIVE = {
  target_days_before: null,
  target_time: null,
  target_period: null,
  target_slot_id: null,
} as const

/** `sanitizeTaskModelFields`'s relative-target floor (see there). */
function sanitizeRelativeOffsets(
  enrichment: EnrichmentResult,
  inputText: string,
  taskId?: number,
): EnrichmentResult {
  if (enrichment.target_days_before == null) return { ...enrichment, ...NO_RELATIVE }
  const why = enrichment.rrule
    ? 'a repeat'
    : !enrichment.deadline_at
      ? 'no deadline'
      : !RELATIVE_CUE.test(inputText)
        ? 'no wording counted from the deadline'
        : null
  if (why) {
    log.info('ai', `Enrichment[${taskId ?? '-'}]: dropped a relative target (${why})`)
    return { ...enrichment, ...NO_RELATIVE }
  }
  return { ...enrichment, due_at: null, on_deck_day: null }
}

/**
 * RELATIVE TARGETS, last (2026-10-24): the offsets that survived
 * `sanitizeTaskModelFields` turned into what is stored — the time and the
 * period link (`relativeTargetTime`, the table in relative-wording.ts) —
 * after every date step, so the deadline is the one written. Dropped, logged,
 * when the deadline did not survive those steps, or when a time on the deadline day
 * falls after the deadline's (the API's `after_deadline` 400 — enrichment
 * never fails a task for it: the deadline stands alone). Local values, like
 * the rest of the post-process.
 */
export function resolveEnrichmentRelative(
  enrichment: EnrichmentResult,
  inputText: string,
  ctx: RelativeTimeContext,
  taskId?: number,
): EnrichmentResult {
  const days = enrichment.target_days_before
  if (days == null) return { ...enrichment, ...NO_RELATIVE }
  const deadline = enrichment.deadline_at
  if (!deadline) {
    log.info('ai', `Enrichment[${taskId ?? '-'}]: dropped a relative target (deadline dropped)`)
    return { ...enrichment, ...NO_RELATIVE }
  }
  const at = relativeTargetTime(enrichment, inputText, ctx)
  const deadlineClock = /T(\d{2}:\d{2})/.exec(deadline)?.[1]
  if (days === 0 && deadlineClock && at.time > deadlineClock) {
    log.info(
      'ai',
      `Enrichment[${taskId ?? '-'}]: dropped a relative target (${at.time} on the deadline day is after the deadline)`,
    )
    return { ...enrichment, ...NO_RELATIVE }
  }
  log.info(
    'ai',
    `Enrichment[${taskId ?? '-'}]: relative target ${days} day(s) before at ${at.time} (${at.source})`,
  )
  return { ...enrichment, target_time: at.time, target_slot_id: at.slot_id }
}

/**
 * Words that name a PART OF A DAY, or a moment in it, without a clock time:
 * "tomorrow morning", "tonight", "this afternoon", "after work", "before
 * bed", "at lunch". With one, the model's time is its reading of those words
 * — a target (A5), never a deck — even when it equals the default task time
 * ("tomorrow morning" IS the morning time). Generous on purpose: a false hit
 * only keeps the old behaviour (a target).
 */
const PART_OF_DAY =
  /\b(morning|mornings|afternoon|evening|tonight|night|overnight|noon|midday|lunch|lunchtime|breakfast|dinner|supper|bedtime|first thing|eod|cob|sunrise|sunset|dawn|dusk)\b|\b(before|in|to) bed\b|\b(after|before) (work|school|class|church|the gym)\b|\bon (my|the) way\b|\bend of (the )?(day|business)\b/i

/** "this weekend" as a day; "sometime/over/during this weekend" is a pace (A5). */
const THIS_WEEKEND = /\bthis (coming )?weekend\b/i
const WEEKEND_PACE =
  /\b(some ?time|over|during|at some point|anytime|any time)\s+this (coming )?weekend\b/i

/** Weekday names by Luxon weekday (1 = Monday): "do it Tuesday" said on a Tuesday names today. */
const WEEKDAY_WORDS: Record<number, RegExp> = {
  1: /\bmon(day)?s?\b/i,
  2: /\btues?(day)?s?\b/i,
  3: /\bwed(s|nesday)?s?\b/i,
  4: /\bthu(r|rs|rsday)?s?\b/i,
  5: /\bfri(day)?s?\b/i,
  6: /\bsat(urday)?s?\b/i,
  7: /\bsun(day)?s?\b/i,
}

export interface DeckDayOptions {
  /** HH:MM, the user's default task time (`users.morning_time`). */
  morningTime: string
  /** UTC ISO: where "Target today" puts a task now (`targetTodayTime`) — the fallback placement. */
  todayTarget: string
  /**
   * HH:MM, the user's rollover (`rolloverTimeForUser`). Between local midnight
   * and the rollover, a bare "tomorrow" means the coming day — the calendar
   * today (A4). Absent: no A4.
   */
  rolloverTime?: string
  /**
   * HH:MM, the user's day boundary (`dayBoundaryForUser`: the day start with
   * the task queue on, midnight off). "This weekend" is read on the OpenTask
   * day (part 2, 2026-10-26): at 00:30 Monday with a 3:00 AM start it is still
   * Sunday — this weekend's last day — as at 23:30.
   */
  dayStart: string
  /** The user's check-in day (Luxon weekday): a bare "this weekend" decks it when it is a weekend day. */
  checkInDay?: CheckInDay
}

/**
 * The day "this weekend" decks (review): with Saturday or Sunday named
 * ("plan Sunday brunch this weekend"), that day of this weekend — even when
 * the model picked the other; with another weekday named, none (the model's
 * day stands); with none named, `thisWeekendDay`.
 */
function weekendDeckDay(
  inputText: string,
  today: DateTime,
  checkInDay: CheckInDay,
): DateTime | null {
  const named = [6, 7].filter((d) => WEEKDAY_WORDS[d].test(inputText))
  if (named.length === 1) {
    const saturday = thisWeekendDay(today, 6)
    const base = today.weekday === 7 ? today.minus({ days: 1 }) : saturday
    const day = base.plus({ days: named[0] - 6 })
    return day < today ? today : day
  }
  if (Object.values(WEEKDAY_WORDS).some((re) => re.test(inputText))) return null
  return thisWeekendDay(today, checkInDay)
}

/** The day a bare "this weekend" decks: today on a weekend day, else the check-in day (if a weekend day) or Saturday. */
function thisWeekendDay(today: DateTime, checkInDay: CheckInDay): DateTime {
  if (today.weekday >= 6) return today
  const target = checkInDay >= 6 ? checkInDay : 6
  return today.plus({ days: target - today.weekday })
}

/** A minute count from now: "in 30 minutes", "in a few mins", "in ten minutes". */
const IN_MINUTES_CUE =
  /\bin (a few|a couple( of)?|an?|\d{1,3}|five|ten|fifteen|twenty|thirty|forty|forty-five|fifty) (minutes?|mins?)\b/i

/**
 * Words that say WHEN in the day: a clock time, a part of day, "remind me" or
 * "nag me" (D3 ruling, and 2026-10-22: the phrases that ask for a nag), or a
 * count from now (in hours or minutes). A bare date from such words is a
 * target, never a deck.
 */
function saysATime(inputText: string): boolean {
  return [
    CLOCK_TIME,
    PART_OF_DAY,
    REMIND_ME,
    NOW_CUE,
    IN_HOURS_CUE,
    IN_HOURS_RANGE_CUE,
    IN_MINUTES_CUE,
  ].some((re) => re.test(inputText))
}

/**
 * "remind me Monday" and "nag me Monday" (Trent, 2026-10-22; also "nag me on
 * Monday", "nag me next Monday") ask for a nag at a time: a target at the
 * default time, not a deck. "nag me" is also the nag-interval phrase, so two
 * forms are left out: the off switch ("don't nag me", "do not nag me", "never
 * nag me" — the user asked for NO nag, so a bare day still decks) and an
 * interval ("nag me every 30 minutes" sets `auto_snooze_minutes`; a bare day
 * beside it decks as before).
 */
const REMIND_ME =
  /\bremind me\b|(?<!\b(?:don['’]?t|do not|never|no need to) )\bnag me\b(?!\s+every\b)/i

/** Day phrases with numbers in them, taken out before `mayStateATime` looks for a number. */
const DAY_NUMBER_PHRASES = [
  /\bin (\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a couple( of)?|a few) (days?|weeks?|months?)\b/gi,
  /\b\d{1,2}(st|nd|rd|th)\b/gi,
  /\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b/gi,
  /\b(19|20)\d{2}\b/g,
]

/**
 * THE FLOOR'S BLOCK (D3 review): words that may state a time `CLOCK_TIME`
 * can't read — any number left once the day phrases with numbers are taken
 * out ("Thursday 9", "9:00", "0900", "9a", "9 a m", "@ 9", "around 9"), a
 * number word ("at nine", "nine o'clock"), "o'clock", or "in the AM/PM".
 * With one, the model's time may be the user's, so the floor stays off.
 * Deliberately generous: a false hit only keeps the target.
 */
function mayStateATime(inputText: string): boolean {
  const rest = DAY_NUMBER_PHRASES.reduce((text, re) => text.replace(re, ' '), inputText)
  return (
    /\d/.test(rest) ||
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|forty|half past|quarter (past|to|after|of))\b/i.test(
      rest,
    ) ||
    /\b(at|around|about|by) one\b|\bone (o'?clock|thirty|fifteen)\b/i.test(rest) ||
    /\bo'?clock\b|\bin the (am|pm|a\.m\.|p\.m\.)|\b[ap]\.m\./i.test(rest)
  )
}

/**
 * The local calendar day a TIMELESS target names, or null when the target is
 * not timeless. Timeless is:
 * - a bare date ("2026-10-24") — what the prompt asks for a day with no time;
 * - THE CODE FLOOR (B12): a full datetime exactly at the default task time,
 *   when the words name a day (`DAY_NAMED` / `mayNameADay`) but no clock time,
 *   no part of day and no soon cue — the model filled in the old default for
 *   a day with no time, which is what the prompt used to ask. ("tomorrow
 *   morning" has a part of day, so it stays a target at that same time.)
 */
function timelessDay(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  morningTime: string,
): string | null {
  const value = enrichment.due_at?.trim()
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  if (enrichment.rrule || saysATime(inputText) || mayStateATime(inputText)) return null
  if (!(DAY_NAMED.test(inputText) || mayNameADay(inputText))) return null
  const local = parseLocalDateTime(value, timezone)
  if (!local) return null
  const [hour, minute] = (morningTime || '09:00').split(':').map(Number)
  if (local.hour !== hour || local.minute !== minute) return null
  log.info('ai', 'Enrichment: a target at the default time with no time in the words — a day only')
  return local.toFormat('yyyy-MM-dd')
}

/**
 * ON DECK FROM ENRICHMENT (D3, 2026-10-20; spec rule 11, red team A1/A4/A5,
 * B12; docs/TASK-MODEL.md § On deck). A day with no time — "do it Saturday",
 * "today", "tomorrow" — puts the task ON DECK for that day: planned, with no
 * nag. An actual time ("at noon", "1 PM", "this afternoon at 3") or a part of
 * day ("tomorrow morning", "tonight", "this evening") is a target, as before;
 * a deadline word is still a deadline.
 *
 * The model returns a bare date for a day with no time; the code floor
 * (`timelessDay`) also catches the old default-time answer. Then:
 * - a repeating task, or a result with a DEADLINE (A1: "by Friday, do it
 *   Wednesday" keeps a picked Wednesday target, so a deck never meets the
 *   deadline's nag) → the target it always was (`resolveDateOnlyTarget`);
 * - a day already past → the same (`dropUnstatedPastDates` then judges it;
 *   a deck can't be in the past);
 * - no day in the words at all — a date the model invented ("check the
 *   mail") → dropped: no deck and no target. For TODAY the words must name
 *   today ("today", today's weekday, a bare "this weekend" on a weekend day,
 *   or A4's "tomorrow"), since `DAY_NAMED` also fires on "this" / "next";
 * - otherwise `on_deck_day` = that day and `due_at` null, after three fixes
 *   of the day itself, the same ones the target rules make:
 *   · "today" as the only day → the calendar today (the late-evening UTC-date
 *     slip `resolveTodayLocalDate` fixes for targets);
 *   · "tomorrow" said between local midnight and the rollover → the coming
 *     day, the CALENDAR TODAY (A4: at 00:30 the user means "after I sleep");
 *     said after the rollover and dated today → tomorrow (`resolveSameDayPast`).
 *     The same window moves a TIMED "tomorrow at 3pm" (`resolveEarlyTomorrow`);
 *   · a bare "this weekend" (not "sometime this weekend", a pace) → today on
 *     a weekend day, else the coming check-in day when that is a weekend day,
 *     else Saturday.
 *
 * Whether the deck is WRITTEN is the apply step's call (`deckOrTarget`): the
 * task queue switch, the row's kind and a deadline already on the task can
 * still turn it back into the target. Runs first among the date rules (it
 * takes `resolveDateOnlyTarget`'s place and calls it for every non-deck
 * answer), on the model's LOCAL value. Pure apart from `now`; exported for
 * the quality harness and tests.
 */
export function resolveDeckDay(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  opts: DeckDayOptions,
  now: Date = new Date(),
): EnrichmentResult {
  const asTarget = () =>
    resolveDateOnlyTarget(enrichment, inputText, timezone, opts.morningTime, opts.todayTarget, now)
  const stated = timelessDay(enrichment, inputText, timezone, opts.morningTime)
  if (stated === null) return asTarget()
  const day = DateTime.fromISO(stated, { zone: timezone })
  if (!day.isValid) return { ...enrichment, due_at: null }
  // A1 / repeating: the target it always was (the floor's datetime already is one).
  // So is a bare date from words that say when in the day (D3 review): "Friday
  // evening", "Saturday at 3pm", "remind me Monday", "nag me Monday" go to the target path.
  if (enrichment.rrule || enrichment.deadline_at || saysATime(inputText)) return asTarget()

  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const settled = settleDeckDay(day.startOf('day'), inputText, today, opts, now)
  // "This weekend" was settled on the OpenTask day, which its day is never
  // before: at 00:30 Monday (3:00 AM start) Sunday's deck, as at 23:30.
  if (settled.weekend)
    return { ...enrichment, due_at: null, on_deck_day: settled.deck.toISODate()! }
  // A deck never lands in the past (D3 ruling): yesterday — the words were
  // said before midnight, the model answered after — is the calendar today
  // (and the words named that day, so it counts as named).
  const fromYesterday =
    +settled.deck === +today.minus({ days: 1 }) &&
    (DAY_NAMED.test(inputText) || mayNameADay(inputText))
  const todayNamed = settled.todayNamed || fromYesterday
  const deck = fromYesterday ? today : settled.deck
  if (deck < today) return asTarget()
  const named = +deck === +today ? todayNamed : DAY_NAMED.test(inputText) || mayNameADay(inputText)
  if (!named) {
    log.info('ai', 'Enrichment: dropped a day with no time the input does not name')
    return { ...enrichment, due_at: null }
  }
  const onDeck = deck.toFormat('yyyy-MM-dd')
  if (onDeck !== stated) log.info('ai', `Enrichment: deck day ${stated} moved to ${onDeck}`)
  return { ...enrichment, due_at: null, on_deck_day: onDeck }
}

/**
 * A4 — ONE RULE FOR DECKS AND TARGETS (red team A4; designer 2026-10-20):
 * "tomorrow" said between local midnight and the user's rollover means the
 * coming day — the CALENDAR TODAY. At 00:30 on Tuesday the user is still in
 * Monday night: "tomorrow" is Tuesday, "tomorrow at 3pm" is Tuesday 3 PM.
 * The window is the same for both (`settleDeckDay` for a deck,
 * `resolveEarlyTomorrow` for a target), so they can't drift. No rollover
 * passed (a pure call that doesn't know the user): never.
 */
export function saidTomorrowBeforeRollover(
  inputText: string,
  timezone: string,
  rolloverTime: string | undefined,
  now: Date,
): boolean {
  if (!rolloverTime || !saysTomorrow(inputText)) return false
  // The stretch after midnight that is still the day before (`isLateNight`):
  // a day start after 12:00 has none — before midnight it is already the
  // next OpenTask day, and "tomorrow" means what it says.
  return isLateNight(now, timezone, rolloverTime)
}

/**
 * A4 FOR A TARGET (designer 2026-10-20): a one-off target the model dated on
 * the CALENDAR tomorrow, from words that say "tomorrow" between midnight and
 * the rollover (`saidTomorrowBeforeRollover`), moves back one day — "tomorrow
 * at 3pm" at 00:30 Tuesday → Tuesday 3 PM (the model, reading the calendar,
 * says Wednesday). A target the model already put on the calendar today is
 * left alone, and `resolveSameDayPast` does not push it to tomorrow in this
 * window. Not when the moved time would already have passed ("tomorrow at
 * 12:15am" said at 00:30 stays the next night's): a target never lands in
 * the past. Repeating tasks are their rule's business. Runs after
 * `resolveTodayLocalDate` and before `resolveSameDayPast`, on the model's
 * LOCAL value. Pure apart from `now`; exported for the harness and tests.
 */
export function resolveEarlyTomorrow(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  rolloverTime: string | undefined,
  now: Date = new Date(),
): EnrichmentResult {
  if (enrichment.rrule) return enrichment
  if (!saidTomorrowBeforeRollover(inputText, timezone, rolloverTime, now)) return enrichment
  const nowLocal = DateTime.fromJSDate(now).setZone(timezone)
  const back = (value: string | null): string | null => {
    const at = value ? parseLocalDateTime(value, timezone) : null
    if (!at || !at.hasSame(nowLocal.plus({ days: 1 }), 'day')) return value
    const moved = at.minus({ days: 1 })
    return moved <= nowLocal ? value : toLocalIso(moved, value)
  }
  const dueAt = back(enrichment.due_at)
  const deadlineAt = back(enrichment.deadline_at)
  if (dueAt === enrichment.due_at && deadlineAt === enrichment.deadline_at) return enrichment
  log.info('ai', 'Enrichment: "tomorrow" said before the rollover — the coming day (A4)')
  return { ...enrichment, due_at: dueAt, deadline_at: deadlineAt }
}

/**
 * The deck day after the fixes `resolveDeckDay` lists ("today" as the only
 * day, A4's "tomorrow", the same-day "tomorrow", a bare "this weekend"), and
 * whether the words name TODAY (which a deck today needs).
 */
function settleDeckDay(
  day: DateTime,
  inputText: string,
  today: DateTime,
  opts: DeckDayOptions,
  now: Date,
): { deck: DateTime; todayNamed: boolean; weekend: boolean } {
  const tomorrow = today.plus({ days: 1 })
  const early = saidTomorrowBeforeRollover(inputText, today.zoneName!, opts.rolloverTime, now)
  const tomorrowSaid = saysTomorrow(inputText)
  const saysToday = TODAY_CUE.test(inputText)
  // "This weekend" on the OpenTask day's weekday (part 2), not the calendar's.
  const weekendDay =
    THIS_WEEKEND.test(inputText) && !WEEKEND_PACE.test(inputText)
      ? weekendDeckDay(
          inputText,
          openTaskLocalDay(now, today.zoneName!, opts.dayStart),
          opts.checkInDay ?? CHECK_IN_DAY_DEFAULT,
        )
      : null

  let deck = day
  if (saysToday && !OTHER_DAY_WORD.test(inputText)) deck = today
  else if (early && +deck === +tomorrow)
    deck = today // A4
  else if (tomorrowSaid && !early && +deck === +today) deck = tomorrow
  else if (weekendDay) return { deck: weekendDay, todayNamed: true, weekend: true }

  const todayNamed = saysToday || WEEKDAY_WORDS[today.weekday].test(inputText) || early
  return { deck, todayNamed, weekend: false }
}

/**
 * The target a deck day stands for, as UTC ISO, when the deck can't be
 * written (`deckOrTarget`): the target pre-D3 enrichment gave the same words
 * (`resolveDateOnlyTarget`) — today → where "Target today" puts it
 * (`todayTarget`), any other day → the default task time on it.
 */
export function deckDayAsTarget(
  day: string,
  timezone: string,
  morningTime: string,
  todayTarget: string,
  /** The user's day boundary: a deck day is an OpenTask date ("Day starts at" PR 2). */
  dayStart: string,
  now: Date = new Date(),
): string {
  const local = DateTime.fromISO(day, { zone: timezone })
  if (day === openTaskDayOf(now, timezone, dayStart)) return todayTarget
  const [hour, minute] = (morningTime || '09:00').split(':').map(Number)
  return local.set({ hour, minute, second: 0, millisecond: 0 }).toUTC().toISO()!
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

/** Day words a misspelling could be: relative days, weekdays, months. */
const DAY_WORDS = [
  'today',
  'tonight',
  'tomorrow',
  'yesterday',
  'weekend',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * Shorthand for "tomorrow" / "next" ("tmr", "2moro", "nxt"), and days named by
 * an occasion rather than a date ("Halloween party at 7pm" the day before).
 */
const DAY_HINT =
  /\b(tom|tmr|tmw|2mor|2moro|nxt)|\b(christmas|xmas|thanksgiving|halloween|easter|valentines?|hanukkah|passover|holiday|birthday|anniversary|payday)\b/i

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and
 * swaps of two neighbouring letters ("thrusday") each count 1.
 */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

/**
 * Could the words name a day `DAY_NAMED` can't read? True on any number left
 * once the clock time is taken out ("on the 15 at noon"), a `DAY_HINT`, or a
 * word of 4+ letters within 2 edits of a day word (1 for words of 5 or fewer
 * letters): "tommorow", "thrusday", "wensday", "ocotber". Deliberately
 * generous — a false hit only means the model's date is kept.
 */
function mayNameADay(inputText: string): boolean {
  const rest = inputText.replace(new RegExp(CLOCK_TIME.source, 'gi'), ' ')
  if (/\d/.test(rest) || DAY_HINT.test(rest)) return true
  const words = rest.toLowerCase().match(/[a-z]{4,}/g) ?? []
  return words.some((w) =>
    DAY_WORDS.some((day) => editDistance(w, day) <= (day.length <= 5 ? 1 : 2)),
  )
}

/**
 * A TIME WITH NO DAY is its next occurrence (Trent, 2026-10-14: "Add Matthew
 * time 8:30am … It's supposed to actually be at 8:30 am this morning"): today
 * while that time is still ahead, otherwise tomorrow. The prompt says so; this
 * catches the model returning one already passed ("8:30am" said at 10 AM, given
 * today at 8:30), which would land over target the moment it is made.
 *
 * Forward, with ONE narrow exception. Whether the words name a day is a
 * regex's guess, and a day it can't read — "tommorow at 3pm" — is still a day:
 * pulling the model's correct "tomorrow" back to today was the first version's
 * bug (quality run, 2026-10-14). So a target still ahead is left alone, except
 * when it is EXACTLY tomorrow, the same time today is still ahead, and nothing
 * in the words could be a day the regex missed (`mayNameADay`: a misspelled
 * day or month, "tmr"/"nxt", a number, an occasion like "Halloween"). Then
 * tomorrow contradicts the rule above (prod, 2026-10-20: "Order replacement
 * books at noon urgent priority" at 10:58 AM came back tomorrow noon, while
 * the model's own reasoning said today) and is pulled back to today. That does
 * not reopen the 10-14 bug: "tommorow" is within two edits of "tomorrow" (and
 * `DAY_NAMED` reads it now besides), so its tomorrow stays. The root fix is
 * `reasoning` first in `EnrichmentResultSchema`; this is the backstop.
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
  if (
    next > nowLocal &&
    local.hasSame(nowLocal.plus({ days: 1 }), 'day') &&
    !mayNameADay(inputText)
  ) {
    log.info('ai', 'Enrichment: moved a time with no day from tomorrow back to today')
    return { ...enrichment, due_at: toLocalIso(next, value) }
  }
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
 * A range of hours: "in 2 or 3 hours", "in 2-3 hrs", "in an hour or two hours"
 * (groups 1-2), and "in an hour or two" with no second "hours" (groups 3-4).
 */
const IN_HOURS_RANGE_CUE =
  /\bin (an|a|one|two|three|four|five|six|\d{1,2})(?: (?:hours?|hrs?))? ?(?:or|to|-|–) ?(two|three|four|five|six|seven|eight|\d{1,2}) (?:hours?|hrs?)\b|\bin (an|a|one) (?:hour|hr) or (two|three)\b/i

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
  seven: 7,
  eight: 8,
}

const hourCount = (word: string) => HOUR_WORDS[word.toLowerCase()] ?? Number(word)

/**
 * "in an hour or two" at 2:30 → a whole hour inside 3:30–4:30, i.e. 4:00. The
 * model's pick stands when it is on a quarter hour inside the range (3:30 is
 * the user's too); otherwise the first whole hour at or after the short end,
 * or — for a range under an hour wide with no whole hour in it — the first
 * quarter hour.
 */
function rangeTarget(
  model: DateTime | null,
  nowMinute: DateTime,
  lo: number,
  hi: number,
): DateTime {
  const earliest = nowMinute.plus({ hours: lo })
  const latest = nowMinute.plus({ hours: hi })
  if (model && model.minute % 15 === 0 && model >= earliest && model <= latest) return model
  const wholeHour = earliest.minute === 0 ? earliest : earliest.startOf('hour').plus({ hours: 1 })
  return wholeHour <= latest ? wholeHour : ceilQuarter(earliest)
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
 * - "in an hour or two" / "in 2 or 3 hours" → a whole hour inside the range.
 *   The model picks; its pick is kept when it is on a quarter hour inside the
 *   range, and otherwise replaced (`rangeTarget`). In the quality runs it
 *   rounded "in 2 or 3 hours" at 2:10 to 4:00 — before the range.
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
  const cues = [NOW_CUE, IN_HOURS_CUE, IN_HOURS_RANGE_CUE].map((re) => re.exec(inputText))
  const found = cues.filter((c) => c !== null)
  // Two at once ("now … in an hour") states two times: leave it to the model.
  if (found.length !== 1) return enrichment
  const [nowCue, hoursCue] = cues
  const cue = found[0]
  const rest = inputText.slice(0, cue.index) + ' ' + inputText.slice(cue.index + cue[0].length)
  if (CLOCK_TIME.test(rest) || SOON_BLOCKER.test(rest)) return enrichment

  const nowMinute = DateTime.fromJSDate(now).setZone(timezone).startOf('minute')
  let target: DateTime
  if (cue === nowCue) target = ceilQuarter(nowMinute.plus({ minutes: 15 }))
  else if (cue === hoursCue) target = ceilQuarter(nowMinute.plus({ hours: hourCount(cue[1]) }))
  else {
    const lo = hourCount(cue[1] ?? cue[3])
    const hi = hourCount(cue[2] ?? cue[4])
    if (!(hi > lo)) return enrichment
    target = rangeTarget(parseLocalDateTime(value, timezone), nowMinute, lo, hi)
  }
  const next = toLocalIso(target, value)
  if (next === value) return enrichment
  log.info('ai', `Enrichment: set a "${cue[0].trim()}" target to ${next}`)
  return { ...enrichment, due_at: next }
}

/**
 * Words that could name a day already past, so a past date the model returns
 * may be the user's own: "yesterday", "3 days ago", "last Tuesday", "this past
 * weekend", any weekday ("it expired Monday"), a month name ("Feb 28th"), an
 * ordinal ("the 13th"), a numeric date ("10/13", "2025-10-13") or a year.
 * Deliberately generous: a false "stated" only leaves the model's date alone
 * (the old behaviour); a false "not stated" would erase a date the user gave.
 * "may" counts as the month — erring that way is the safe one.
 */
const PAST_DATE_STATED =
  /\b(yesterday|ago|last|past|previous|earlier|overdue|missed)\b|\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|nesday|sday|urday)?\b|\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}[/.-]\d{1,2}\b|\b(19|20)\d{2}\b/i

/**
 * PAST-DATE GUARD (2026-10-16): a target or deadline the model dated before
 * TODAY (the user's local date), when the words state no such day, is dropped
 * (set to null). The failure that prompted it: grok-4-1-fast gave "now that the
 * lease is signed call the landlord" a target of 2025-10-16 5:15 PM — a year
 * in the past, so the task was over target (and nagging) the moment it was
 * made. A target nobody stated must not exist (the prompt's own rule: no day,
 * no target), and a past one is the worst kind: over target at once.
 *
 * The deadline gets the same rule: a cutoff already passed that the user never
 * said is a hallucination, and a passed deadline changes how the task is
 * treated (bulk snooze holds it back as if High). A month and day with no year
 * ("the deadline is Feb 28th") counts as stated, so `alignTaskModelDates`
 * still rolls it to next year as before.
 *
 * Only the DATE is checked: an earlier time today is `resolveBareTime`'s
 * business. A repeating task is skipped (its first date is the rule's,
 * `pinUnnamedDay`). Runs on the model's LOCAL values, after `resolveSoonTarget`
 * and before `alignTaskModelDates`. Pure apart from `now`; exported for the
 * quality harness and tests.
 */
export function dropUnstatedPastDates(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  if (enrichment.rrule || PAST_DATE_STATED.test(inputText)) return enrichment
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const isPast = (value: string | null) => {
    if (!value) return false
    const local = parseLocalDateTime(value, timezone)
    return local !== null && local.startOf('day') < today
  }
  const dropTarget = isPast(enrichment.due_at)
  const dropDeadline = isPast(enrichment.deadline_at)
  if (!dropTarget && !dropDeadline) return enrichment
  log.info(
    'ai',
    `Enrichment: dropped a past ${[dropTarget && 'target', dropDeadline && 'deadline'].filter(Boolean).join(' and ')} the input does not state`,
  )
  return {
    ...enrichment,
    due_at: dropTarget ? null : enrichment.due_at,
    deadline_at: dropDeadline ? null : enrichment.deadline_at,
  }
}

/** "now that …", "for now", "by now": "now" in a phrase that names no time. */
const NOW_PHRASE = /\b(now that|for now|by now)\b/i

/**
 * "NOW THAT" (2026-10-16): a "now" phrase that names no time — "now that the
 * lease is signed", "for now", "by now" — read as "now" anyway. The real
 * failure: Haiku gave "now that the lease is signed call the landlord" a
 * target of 7:45 PM, said at 7:38 PM. Such a target is dropped.
 *
 * NARROW on purpose (the designer declined a broad "no time words, no
 * target" guard). All of these must hold:
 * - the words contain one of the three phrases;
 * - no real "now" cue (`NOW_CUE`: "right now", "immediately", a closing
 *   "now"), no "in N hours", no clock time, no day or part of day
 *   (`SOON_BLOCKER`) — any of those is a time the user may have meant;
 * - the model's target sits in the slots a model writes when it reads "now"
 *   as the time: from the start of the current quarter hour (7:30 at 7:38)
 *   up to the soon slot `resolveSoonTarget` would give (8:00 at 7:38). That
 *   window is the whole family of "now" answers — the minute itself, it
 *   rounded down, rounded to the nearest or next quarter, or 15 minutes out
 *   rounded up — not a tolerance around one value. Any later target is the
 *   model's own reading of something else and is left alone.
 *
 * Not for repeating tasks; deadlines are never touched. Runs on the model's
 * LOCAL value, after `resolveSoonTarget` and before `resolveSameDayPast`
 * (which would otherwise move a 7:30 "now" to tomorrow). Pure apart from
 * `now`; exported for the quality harness and tests.
 */
export function dropNowPhraseTarget(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || enrichment.rrule || !NOW_PHRASE.test(inputText)) return enrichment
  const otherTime = [NOW_CUE, IN_HOURS_CUE, IN_HOURS_RANGE_CUE, CLOCK_TIME, SOON_BLOCKER]
  if (otherTime.some((re) => re.test(inputText))) return enrichment
  const target = parseLocalDateTime(value, timezone)
  if (!target) return enrichment
  const nowMinute = DateTime.fromJSDate(now).setZone(timezone).startOf('minute')
  const quarterStart = nowMinute.minus({ minutes: nowMinute.minute % 15 })
  const soonSlot = ceilQuarter(nowMinute.plus({ minutes: 15 }))
  if (target < quarterStart || target > soonSlot) return enrichment
  log.info('ai', 'Enrichment: dropped a "now" target from a phrase that names no time')
  return { ...enrichment, due_at: null }
}

/** "today" / "tonight" as day words ("Tonights" or "todays" are not). */
const TODAY_DAY_WORD = /\b(today|tonight)\b/i

/**
 * Any other day in the words: with one, "today" may not be the day the task
 * is for ("today or tomorrow", "Tuesday — bring today's notes"), so the
 * "today" rule below leaves the model's date alone. Generous on purpose.
 */
const OTHER_DAY_WORD =
  /\b(tomorrow|tmrw|tomm?orr?ow|yesterday|weekend|next|week|month|year)\b|\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|nesday|sday|urday)?s?\b|\b(jan|january|feb|february|mar|march|apr|april|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\bin (an?|one|\d+|two|three|four|five|six|seven) (days?|weeks?|months?)\b/i

/**
 * "TODAY" IS TODAY'S LOCAL DATE (2026-10-17). The real failure: SDK, at
 * 10:57 PM CDT, put a "today" task on the next day — the UTC date. Late
 * evening is when Trent dictates, so a "today" or "tonight" task the model
 * dated another day (or today, at a time already gone) lands today, ahead:
 *
 * - a clock time in the words ("tonight at 11pm", "today at 3") → that time
 *   today, as said — even if it has passed (the user's own words; like
 *   "tonight at 7" said at 8 PM, kept);
 * - no clock time ("call the bank today", "tonight") → the model's time of
 *   day today while it is still ahead; once passed — also when the model put
 *   it on today already, e.g. "tonight" as the 10 PM sleep time said at
 *   10:57 PM — the app's own placement
 *   of a bare "today" (`todayTarget`, the Today button's time — the next
 *   period, or the top of the next hour). NOT the same-day rule's "tomorrow
 *   at the same time": that would put a "today" task on tomorrow, the bug
 *   this fixes. (The same-day rule leaves "today"/"tonight" texts alone for
 *   the same reason.)
 *
 * Only when "today"/"tonight" is the ONLY day in the words (`OTHER_DAY_WORD`):
 * "today or tomorrow", "Tuesday … today's notes" stay as the model read them.
 * One-offs only: a repeating task's first date is its rule's and the
 * first-occurrence rule's ("every day starting today" made at 10:57 PM rolls
 * to tomorrow's occurrence, #286/#287); moving it to a passed today would
 * only be rolled again. Deadlines are untouched.
 *
 * Runs after `dropNowPhraseTarget` and BEFORE `resolveSameDayPast`, so every
 * later rule reads the corrected date; the same-day rule then leaves it
 * alone (it never acts on a "today"/"tonight" text). Pure apart from `now`;
 * exported for the quality harness and tests.
 */
export function resolveTodayLocalDate(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  todayTarget: string,
  now: Date = new Date(),
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || enrichment.rrule) return enrichment
  if (!TODAY_DAY_WORD.test(inputText) || OTHER_DAY_WORD.test(inputText)) return enrichment
  const target = parseLocalDateTime(value, timezone)
  if (!target) return enrichment
  const nowLocal = DateTime.fromJSDate(now).setZone(timezone)
  const namedClock = CLOCK_TIME.test(inputText)
  // Already today: only a passed, unnamed time is moved ("tonight" given the
  // 10 PM sleep time at 10:57 PM); a time the user said stays as said.
  if (target.hasSame(nowLocal, 'day') && (namedClock || target >= nowLocal)) return enrichment
  const sameTimeToday = nowLocal.set({
    hour: target.hour,
    minute: target.minute,
    second: 0,
    millisecond: 0,
  })
  const placed =
    namedClock || sameTimeToday > nowLocal
      ? sameTimeToday
      : DateTime.fromISO(todayTarget, { zone: 'utc' }).setZone(timezone)
  const next = toLocalIso(placed, value)
  if (next === value) return enrichment
  log.info('ai', `Enrichment: a "today" target (${target.toISO()}) moved to ${next}`)
  return { ...enrichment, due_at: next }
}

/** "tomorrow" as a word ("Tomorrowland" is not one), or the common "tmrw". */
const TOMORROW_WORD = /\b(tomm?orr?ow|tmrw|tmr|tmw|2moro|2morrow|tomoro)\b/i

/**
 * Whether the words say "tomorrow" — also misspelled (D3 review): the common
 * spellings above, or a word of 6+ letters within 2 edits of "tomorrow"
 * ("tomorow", "tommorrow", "tomorrw"). "Tomorrowland" is one word, not this.
 */
function saysTomorrow(inputText: string): boolean {
  if (TOMORROW_WORD.test(inputText)) return true
  const words = inputText.toLowerCase().match(/[a-z]{6,}/g) ?? []
  return words.some((w) => editDistance(w, 'tomorrow') <= 2)
}

/**
 * Words that put the task on TODAY, or count from now: with one, a target
 * today is the user's and the same-day rules below leave it alone.
 */
const TODAY_WORDS =
  /\b(today|tonight|now|immediately|asap)\b|\bthis (morning|afternoon|evening)\b|\bin (an?|one|\d+|two|three|four|five|six) (minutes?|mins?|hours?|hrs?)\b/i

/**
 * SAME-DAY FIXES (2026-10-16), for a one-off target the model dated TODAY:
 *
 * 1. "tomorrow" in the words and the target is today → the same time
 *    tomorrow. The real failure: Haiku, at 7:52 PM on a Friday, turned "call
 *    mom tomorrow evening" into Friday 7:00 PM.
 * 2. Otherwise, a target today that is already past (before the current
 *    minute) and whose clock time the words do not name → the same time
 *    tomorrow. "call mom in the evening" read at 7:52 PM as 7:00 PM today
 *    becomes 7:00 PM tomorrow.
 *
 *    Why tomorrow at the model's time, and not the soon slot or the next
 *    hour: when the words name a part of day ("evening", "after lunch") but
 *    no clock, the model's time IS its reading of that part of day — 7 PM is
 *    "evening". That part of day has passed today, so its next occurrence is
 *    tomorrow's; moving it to "in 15 minutes" would turn an evening task into
 *    a now task, which nobody said. With no time words at all the same holds:
 *    the time the model picked passed, tomorrow is its next occurrence (the
 *    model's pick of a day — not this — decides whether there is a target).
 *
 * Left alone:
 * - a clock time in the words ("7pm" said at 8 PM): `resolveBareTime`'s
 *   business, forward only, and it already ran;
 * - a word that puts it on today or counts from now (`TODAY_WORDS`: "today",
 *   "tonight", "this evening", "now", "in an hour"): the user said today, so
 *   a passed time today is their call, not a misread day;
 * - a repeating task (its first date is the rule's), a target on any other
 *   day, and every deadline.
 *
 * Runs on the model's LOCAL value, after `dropNowPhraseTarget` and before
 * `dropUnstatedPastDates`. Pure apart from `now`; exported for the quality
 * harness and tests.
 */
export function resolveSameDayPast(
  enrichment: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date = new Date(),
  /** The user's rollover: before it, "tomorrow" IS today (A4), so rule 1 stands down. */
  rolloverTime?: string,
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || enrichment.rrule || TODAY_WORDS.test(inputText)) return enrichment
  const target = parseLocalDateTime(value, timezone)
  if (!target) return enrichment
  const nowMinute = DateTime.fromJSDate(now).setZone(timezone).startOf('minute')
  if (!target.hasSame(nowMinute, 'day')) return enrichment
  const saidTomorrow =
    saysTomorrow(inputText) && !saidTomorrowBeforeRollover(inputText, timezone, rolloverTime, now)
  const passedUnnamed = target < nowMinute && !CLOCK_TIME.test(inputText)
  if (!saidTomorrow && !passedUnnamed) return enrichment
  const next = toLocalIso(target.plus({ days: 1 }), value)
  log.info(
    'ai',
    `Enrichment: moved a target today to tomorrow (${saidTomorrow ? '"tomorrow" in the words' : 'its time had passed'})`,
  )
  return { ...enrichment, due_at: next }
}

/**
 * A REPEATING task's first date the model put in the PAST (earlier today or
 * any earlier day) rolls to the next occurrence — the create path's rule
 * (`rollPassedFirstOccurrence`, 2026-10-16), applied here because enrichment
 * writes its rule and date onto the just-created task as an update, not
 * through createTask. "submit my timesheet every Friday by 5pm" made Friday
 * at 8:30 PM → next Friday 5 PM; "pay mortgage on the 15th of every month"
 * made on the 16th → next month's 15th.
 *
 * Only for a NEW task (`postProcessTaskDates`'s `newTask`): enrichment of a
 * task that was created title-only and has had no date or rule yet. A
 * re-enrichment of a task that already has a date or a rule is an existing
 * task, and its dates are not rolled. Runs last, on the model's LOCAL value,
 * after `pinUnnamedDay` has settled the rule. Pure apart from `now`; exported
 * for the quality harness and tests.
 */
export function rollPassedRepeatStart(
  enrichment: EnrichmentResult,
  timezone: string,
  now: Date,
  /** The user's day boundary: a floating rule's day 0 is the OpenTask day. */
  dayStart: string,
): EnrichmentResult {
  const value = enrichment.due_at
  if (!value || !enrichment.rrule) return enrichment
  const local = parseLocalDateTime(value, timezone)
  if (!local) return enrichment
  const first = rollPassedFirstOccurrence(
    enrichment.rrule,
    local.toJSDate(),
    timezone,
    now,
    dayStart,
  )
  if (first.getTime() === local.toJSDate().getTime()) return enrichment
  const next = toLocalIso(DateTime.fromJSDate(first).setZone(timezone), value)
  log.info('ai', `Enrichment: a repeat's first date today had passed; moved to ${next}`)
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
  input: EnrichmentResult,
  inputText: string,
  timezone: string,
  now: Date,
  /** The user's day boundary (`dayBoundaryForUser`): "today" is the OpenTask day. */
  dayStart: string,
): EnrichmentResult {
  if (!input.rrule) return input
  const enrichment = withNormalizedRule(input)
  let parts = (enrichment.rrule ?? '').split(';')
  if (parts.some((p) => /^FREQ=YEARLY$/i.test(p))) {
    return pinYearlyFirstOfMonth(enrichment, parts, inputText, timezone)
  }
  const part = unnamedDayPart(parts, inputText)
  if (!part) return enrichment

  const due = enrichment.due_at ? parseLocalDateTime(enrichment.due_at, timezone) : null
  const keepDue = due !== null && START_CUE.test(inputText)
  // TODAY is the OpenTask day (part 2, 2026-10-26): at 00:30 Monday with a
  // 3:00 AM start, "every 2 weeks" is every other Sunday, as at 23:30.
  const day = keepDue ? due : openTaskLocalDay(now, timezone, dayStart)
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
    ...withoutQuotaFields(enrichment),
    due_at: null,
    deadline_at: null,
    horizon: null,
    labels: [],
    project_name: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    // Relative targets (2026-10-24): a reminder has no target to count back.
    ...NO_RELATIVE,
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
 * The model's rule as it is stored (`normalizeRRule`): a WEEKLY/DAILY rule's
 * meaningless BYDAY ordinal ("FREQ=WEEKLY;BYDAY=2TU") is dropped, never a
 * reason to throw the whole enrichment away. First step of both post-process
 * paths (tasks: `postProcessTaskEnrichment`; reminders: `pinUnnamedDay`).
 */
export function withNormalizedRule(enrichment: EnrichmentResult): EnrichmentResult {
  if (!enrichment.rrule) return enrichment
  const rrule = normalizeRRule(enrichment.rrule)
  return rrule === enrichment.rrule ? enrichment : { ...enrichment, rrule }
}

/**
 * Post-parse guard: if the RRULE specifies BYDAY, ensure due_at's weekday matches.
 * Models occasionally emit a weekday adjacent to the intended one (off-by-one on
 * "next Thursday"). Snap forward to the nearest valid BYDAY, preserving the
 * hour/minute/second. Returns the original DateTime when no snap is needed.
 *
 * A rule whose BYDAY carries an ordinal ("monthly on the 1st Saturday",
 * BYDAY=1SA; 2026-10-20) names particular weekdays of the month, so the
 * weekday alone is not enough: the date becomes the rule's first occurrence
 * on or after the model's date, from the recurrence engine, at the model's
 * time of day. Exported for tests.
 */
export function snapDueAtToByday(local: DateTime, rrule: string): DateTime {
  const components = parseRRule(rrule)
  if (ordinalsCount(components)) {
    const first = computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: local.toFormat('HH:mm'),
      timezone: local.zoneName ?? 'UTC',
      completedAt: local.minus({ milliseconds: 1 }).toJSDate(),
      prevDueAt: null,
    })
    const snapped = DateTime.fromJSDate(first).setZone(local.zone).set({ second: local.second })
    return snapped.toMillis() === local.toMillis() ? local : snapped
  }
  const days = bydayDows(components)
  if (days.length === 0) return local
  const dow = getDayOfWeek(local)
  if (days.includes(dow)) return local
  const forwardDistances = days.map((d) => (d - dow + 7) % 7 || 7)
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
 * often said null, but `project_name` was then emitted before `reasoning`, so
 * the field was already set (reasoning has come first since 2026-10-20).
 * Prompt wording did not get that to zero; this does.
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
        new Date(),
        dayBoundaryForUser(user.id),
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
  const decked = collectEnrichmentTarget(
    task,
    enrichment,
    { tracked, proposedDue, userId: user.id },
    write,
  )

  // Upcoming (2026-10-12): a target or deadline the AI set restarts the wait
  // its heads-ups count over, like any other target write — and so does a
  // deck (A6: `target_set_at` is its heads-up anchor; the stamp also takes a
  // queued task out of the queue, rule 3). The snapshot is taken from the
  // re-read row, so it carries the stamp.
  stampTargetSet(write, task, nowUtc(), { deck: decked })
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
): boolean {
  const rrule = changes.fieldsChanged.includes('rrule') ? enrichment.rrule : task.rrule
  const deadlineAt = changes.fieldsChanged.includes('deadline_at')
    ? (enrichment.deadline_at ?? null)
    : task.deadline_at
  const targetCtx = getTargetContext(opts.userId)
  const deck = collectEnrichmentDeck(task, enrichment, opts.tracked, changes)
  const dropPick = deck.dropPick
  const autoEligible = !rrule && !task.is_reminder && !opts.tracked
  const aiRelative = autoEligible
    ? enrichmentRelativeWrite(enrichment, opts.userId, deadlineAt, targetCtx.timezone)
    : null
  const resolved = resolveTarget(
    {
      dueAt: dropPick ? null : (opts.proposedDue ?? task.due_at),
      dueWritten: dropPick || opts.proposedDue !== undefined,
      wasAuto: task.target_auto,
      deadlineAt,
      deadlineChanged: deadlineAt !== task.deadline_at,
      autoEligible,
      // The deadlines page (task-queue switch on, 2026-10-22): no automatic
      // target — "by Friday" leaves the task target-less, on the page from
      // its lead day.
      leads: taskQueueEnabled(),
      ...enrichmentRelative(task, autoEligible, aiRelative),
    },
    targetCtx,
  )
  if (resolved.dueAt !== task.due_at) {
    changes.setClauses.push('due_at = ?')
    changes.values.push(resolved.dueAt)
    changes.fieldsChanged.push('due_at')
  }
  collectEnrichmentRelative(task, resolved.relative, aiRelative, changes)
  if (resolved.auto !== task.target_auto) {
    changes.setClauses.push('target_auto = ?')
    changes.values.push(resolved.auto ? 1 : 0)
    changes.fieldsChanged.push('target_auto')
  }
  const rolloverTime = rolloverTimeForUser(opts.userId)
  collectEnrichmentLead(
    task,
    { deadlineAt, rrule, tracked: opts.tracked, timezone: targetCtx.timezone },
    rolloverTime,
    changes,
  )
  // On deck (2026-10-20, B1): a target the AI set is a pick, and a pick takes
  // the deck off (rule 1); a deadline it found leaves an automatic target, and
  // the deck stays (`deck-clear.ts`).
  collectDeckClear(changes, task, {
    dueAt: resolved.dueAt,
    auto: resolved.auto,
    rrule: rrule ?? null,
    isReminder: task.is_reminder,
    isTracked: opts.tracked,
    // A deadline it found that reminds on or before the deck day wins (A1).
    deadline: {
      at: deadlineAt,
      changed: deadlineAt !== task.deadline_at,
      ctx: targetCtx,
      now: new Date(),
      rolloverTime,
    },
  })
  // A repeating task's date set here is its occurrence (a schedule, not a move)
  // — on a target-anchored repeat. A DEADLINE-ANCHORED one's occurrence is its
  // deadline (2026-10-21, `occurrenceDates`), never a target the AI read: the
  // date is a move of its target, capped above. (Enrichment never makes one —
  // `sanitizeTaskModelFields` drops a rule's deadline; teaching it to is PR 5.)
  const occurrenceAt =
    rrule && !opts.tracked && opts.proposedDue && task.repeat_anchor !== 'deadline'
      ? opts.proposedDue
      : undefined
  if (occurrenceAt !== undefined && occurrenceAt !== task.occurrence_at) {
    changes.setClauses.push('occurrence_at = ?')
    changes.values.push(occurrenceAt)
    changes.fieldsChanged.push('occurrence_at')
  }
  return deck.decked
}

/**
 * Relative targets (2026-10-24): a relative one-off's target follows a
 * deadline the AI moves, and a date the AI picks makes it fixed — the same
 * `resolveTarget` rules as every writer. A relative target the AI READ
 * (`enrichmentRelativeWrite`) is sent as written: `resolveTarget` derives
 * the target from it.
 */
function enrichmentRelative(task: Task, autoEligible: boolean, aiRelative: AiRelative | null) {
  if (!autoEligible) return {}
  if (aiRelative) return { relative: aiRelative.relative, relativeWritten: true }
  return { relative: task.rrule ? null : relativeOf(task) }
}

/** The relative target's columns: the AI's written, or a stored one the write made fixed cleared. */
function collectEnrichmentRelative(
  task: Task,
  left: RelativeTarget | null | undefined,
  aiRelative: AiRelative | null,
  changes: FieldChanges,
): void {
  if (aiRelative && left) collectEnrichmentRelativeWrite(task, aiRelative, changes)
  else collectEnrichmentRelativeClear(task, left, changes)
}

/** A relative target the AI read, as written: the offsets and the period link. */
interface AiRelative {
  relative: RelativeTarget
  slotId: number | null
}

/**
 * RELATIVE TARGETS THE AI SETS (2026-10-24, PR C): the offsets
 * `resolveEnrichmentRelative` mapped ("the evening before" → 1 day, the
 * Evening period), on a one-off with a deadline. The link is resolved at
 * WRITE time like every writer's (`linkTargetTime`, through `resolveTime`):
 * the period's start now, and the OWNER's period — a period deleted since the
 * prompt leaves the mapped time as a custom one. Null — the deadline alone
 * stands — when a time on the deadline day is after the deadline (the API's
 * `after_deadline` 400; enrichment never fails a task for it).
 */
function enrichmentRelativeWrite(
  enrichment: EnrichmentResult,
  ownerId: number,
  deadlineAt: string | null,
  timezone: string,
): AiRelative | null {
  const days = enrichment.target_days_before
  const time = enrichment.target_time
  if (days == null || time == null || deadlineAt === null) return null
  let relative: RelativeTarget = { days_before: days, time }
  let slotId: number | null = null
  if (enrichment.target_slot_id != null) {
    try {
      const linked = linkTargetTime<LinkInput>(ownerId, {
        target_days_before: days,
        target_slot_id: enrichment.target_slot_id,
      })
      relative = { days_before: days, time: linked.input.target_time ?? time }
      slotId = linked.link ?? null
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err
      log.info('ai', `Enrichment: period ${enrichment.target_slot_id} is gone — a custom time`)
    }
  }
  if (relativeOneOffProblem(relative, deadlineAt, timezone)) {
    log.info('ai', 'Enrichment: a relative target after the deadline dropped')
    return null
  }
  return { relative, slotId }
}

/** The AI's relative target written: the three columns, in the same snapshot as `due_at`. */
function collectEnrichmentRelativeWrite(
  task: Task,
  written: AiRelative,
  changes: FieldChanges,
): void {
  // Spelled out (not a template): the RT-G02 / RT-G03 guards read these writes.
  const columns: Array<[keyof Task, string, number | string | null]> = [
    ['target_days_before', 'target_days_before = ?', written.relative.days_before],
    ['target_time', 'target_time = ?', written.relative.time],
    ['target_slot_id', 'target_slot_id = ?', written.slotId],
  ]
  for (const [column, clause, value] of columns) {
    if (task[column] === value) continue
    changes.setClauses.push(clause)
    changes.values.push(value)
    changes.fieldsChanged.push(column)
  }
}

/**
 * A relative target the write made fixed (or a row no longer a one-off): the
 * offsets and the link go with it, in the same snapshot.
 */
function collectEnrichmentRelativeClear(
  task: Task,
  left: RelativeTarget | null | undefined,
  changes: FieldChanges,
): void {
  if (task.rrule || !relativeOf(task) || left) return
  changes.setClauses.push('target_days_before = NULL, target_time = NULL, target_slot_id = NULL')
  changes.fieldsChanged.push('target_days_before', 'target_time', 'target_slot_id')
}

/**
 * A deadline the AI found on a one-off: its lead day (the deadlines page,
 * 2026-10-22, `leadFor`), as any deadline write derives it.
 */
function collectEnrichmentLead(
  task: Task,
  left: {
    deadlineAt: string | null
    rrule: string | null | undefined
    tracked: boolean
    timezone: string
  },
  rolloverTime: string,
  changes: FieldChanges,
): void {
  const { deadlineAt } = left
  if (deadlineAt === task.deadline_at || left.rrule || task.is_reminder || left.tracked) return
  const leadFrom = leadFor(
    { ...ONE_OFF, deadline_at: deadlineAt, lead_days: task.lead_days },
    left.timezone,
    { rolloverTime, now: new Date() },
  )
  if (leadFrom === task.lead_from) return
  changes.setClauses.push('lead_from = ?')
  changes.values.push(leadFrom)
  changes.fieldsChanged.push('lead_from')
}

/** A one-off's schedule fields, for `leadFor`. */
const ONE_OFF = {
  rrule: null,
  repeat_anchor: null,
  target_days_before: null,
  target_time: null,
} as const

/**
 * ON DECK (D3): the deck is written before the target, so the pick-only clear
 * (`collectDeckClear`) leaves it alone; and, as on every deck write ("never
 * both", rule 1), a target the user picked is dropped — returned true so the
 * caller resolves the target with none. (A deadline task never gets here
 * decked — `deckOrTarget` — so no automatic target comes back.)
 */
function collectEnrichmentDeck(
  task: Task,
  enrichment: EnrichmentResult,
  tracked: boolean,
  changes: FieldChanges,
): { dropPick: boolean; decked: boolean } {
  // `deckOrTarget` has already turned a deck that can't be written back into
  // a target, so a day left here is written.
  const deckDay = tracked ? null : (enrichment.on_deck_day ?? null)
  if (deckDay === null) return { dropPick: false, decked: false }
  const decked = deckDay !== task.on_deck_day
  if (decked) {
    changes.setClauses.push('on_deck_day = ?')
    changes.values.push(deckDay)
    changes.fieldsChanged.push('on_deck_day')
  }
  return { dropPick: hasPickedTarget(task), decked }
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

/**
 * THE DECK WRITE'S CHECKS (D3), at write time, on the re-read row — the
 * checks a deck write makes everywhere else (`prepareDeck` in
 * collect-field-changes.ts, which throws; enrichment must not fail over
 * them). A deck the post-process found (`resolveDeckDay`) is written unless:
 * - the task queue switch is off (A14: decks need the rollover that clears
 *   them; enrichment then targets as before D3);
 * - the row REPEATS — the rule the enrichment writes or the one it has. A
 *   repeating task can be decked by the user since 2026-10-20 (`deckSkip` no
 *   longer refuses it), but never by the AI: the rule's first occurrence
 *   would land in `due_at` beside the deck — a deck plus a picked target, the
 *   combination PATCH refuses (`DECK_WITH_RULE_MESSAGE`) — so the day is a
 *   target, as before D3;
 * - the row can't be on deck (rule 6): a reminder, a quota, done or trashed;
 * - the task already has a DEADLINE (A1: "Enrichment with a deadline plus a
 *   day keeps a picked target" — a re-enrichment of a deadline task is no
 *   different from one that states it);
 * - the day is not a valid day today or later (`deckDayProblem`).
 * Then the day becomes the target the same words gave before D3
 * (`deckDayAsTarget`, UTC — `toUtcTimes` has already run).
 *
 * The AI's deck does NOT stamp "considered" or the Just now card (A7 stamps
 * them for the user's own deck tap): the user has not seen this task yet, so
 * nothing was considered — the same reason an AI target doesn't stamp them.
 */
export function deckOrTarget(
  task: Task,
  enrichment: EnrichmentResult,
  user: { id: number; timezone: string },
  now: Date = new Date(),
): EnrichmentResult {
  const stated = enrichment.on_deck_day
  if (!stated) return enrichment
  // Never in the past (D3 ruling): a day that ended while the model ran (the
  // words said before the day turned) is decked for the current day — the
  // OpenTask day ("Day starts at" PR 2: deck days are OpenTask dates).
  const dayStart = dayBoundaryForUser(user.id)
  const today = openTaskDayOf(now, user.timezone, dayStart)
  const day = stated < today ? today : stated
  if (day !== stated) enrichment = { ...enrichment, on_deck_day: day }
  const repeats = !!(enrichment.rrule ?? task.rrule)
  const skip = deckSkip({
    is_reminder: task.is_reminder,
    is_tracked: isTracked(task),
    done: task.done,
    deleted_at: task.deleted_at,
  })
  const why = !taskQueueEnabled()
    ? 'the task queue is off'
    : repeats
      ? 'it repeats'
      : skip
        ? `it is ${skip}`
        : task.deadline_at
          ? 'it has a deadline'
          : deckDayProblem(day, user.timezone, now, dayStart)
  if (!why) return enrichment
  log.info('ai', `Task ${task.id}: not on deck (${why}) — a target on ${day} instead`)
  const dueAt = deckDayAsTarget(
    day,
    user.timezone,
    getTargetContext(user.id).morningTime,
    targetTodayTime(user.id, user.timezone, now),
    dayStart,
    now,
  )
  return { ...enrichment, on_deck_day: null, due_at: dueAt }
}

/**
 * THE USER WINS A RACE WITH THE MODEL (D3 review). The model runs for
 * seconds; meanwhile the user may deck the task, give it a target, or edit
 * it. `applyEnrichment` re-reads the row, and compares it with the row it
 * claimed:
 * - `edited`: `ai-to-process` is gone. Every manual edit (PATCH, the deck
 *   endpoint, bulk edit) removes it (`cancelPendingEnrichment`), so the user
 *   changed SOMETHING — maybe the title — and the whole answer is dropped:
 *   any field the model would write could overwrite theirs.
 * - `dated`: the label is still there but the row's target or deck moved (a
 *   writer that doesn't cancel enrichment — a Snooze-all sweep, a rollover).
 *   Only the date fields are dropped (`withoutDateFields`); the title,
 *   priority, labels, project and notes still apply.
 */
function racedByUser(row: PendingTaskRow, task: Task): 'edited' | 'dated' | null {
  if (!task.labels.includes('ai-to-process')) return 'edited'
  if (task.due_at !== row.due_at || (task.on_deck_day ?? null) !== (row.on_deck_day ?? null)) {
    return 'dated'
  }
  return null
}

/**
 * The answer with every date-shaped field left out (`racedByUser`'s `dated`,
 * and a repeating task on deck — `applyEnrichment`).
 */
function withoutDateFields(
  enrichment: EnrichmentResult,
  why = 'the date moved while the model ran',
): EnrichmentResult {
  log.info('ai', `Enrichment: ${why} — its date fields not applied`)
  return {
    ...enrichment,
    due_at: null,
    on_deck_day: null,
    deadline_at: null,
    horizon: null,
    rrule: null,
    recurrence_mode: null,
    auto_snooze_minutes: null,
    ...NO_RELATIVE,
  }
}

/**
 * NO RULE ONTO A DEADLINE (2026-10-21, until PR 5 teaches enrichment
 * deadline-anchored repeats): a rule on a task with a deadline would make a
 * target-anchored repeat WITH a deadline through raw SQL — a shape the API
 * refuses (`planRepeatSchedule`, L9/A3) — and on a deadline-anchored one would
 * walk a target where its rule walks the deadline. So a rule the model gives
 * such a task (other than the one it has) is left out, logged; the rest of the
 * answer applies.
 */
export function withoutRuleOnDeadline(task: Task, enrichment: EnrichmentResult): EnrichmentResult {
  const hasDeadline = task.deadline_at !== null || task.repeat_anchor === 'deadline'
  if (!hasDeadline || !enrichment.rrule || enrichment.rrule === task.rrule) return enrichment
  log.warn('ai', `Enrichment: task ${task.id} has a deadline — its rule not applied (PR 5)`)
  return { ...enrichment, rrule: null }
}

/**
 * The model's answer, validated — with an invalid rule DROPPED rather than the
 * whole answer lost (2026-10-21): a rule `isValidRRule` refuses (one that never
 * occurs, like the 31st of April) fails only its own field, so the answer is
 * parsed again without it and the drop is logged. Any other problem fails the
 * parse as before.
 */
export function parseEnrichmentAnswer(
  output: unknown,
  taskId: number,
): ReturnType<typeof EnrichmentResultSchema.safeParse> {
  const first = EnrichmentResultSchema.safeParse(output)
  if (first.success || !output || typeof output !== 'object') return first
  const onlyRule = first.error.issues.every((issue) => issue.path[0] === 'rrule')
  if (!onlyRule) return first
  log.warn(
    'ai',
    `Enrichment[${taskId}]: invalid rule dropped: ${String((output as { rrule?: unknown }).rrule)}`,
  )
  return EnrichmentResultSchema.safeParse({ ...output, rrule: null, recurrence_mode: null })
}

/** Bookkeeping columns that ride along with a change but are not news to the user. */
const INTERNAL_FIELDS = [
  'anchor_time',
  'anchor_dow',
  'anchor_dom',
  'horizon_set_at',
  'target_set_at',
  // The task queue (2026-10-19): a target the AI set clears the queue mark.
  'queue_mark',
  'try_tomorrow',
  'queued_at',
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

  const raced = racedByUser(row, task)
  if (raced === 'edited') {
    log.info(
      'ai',
      `Task ${row.id}: edited by the user while the model ran — enrichment not applied`,
    )
    return []
  }
  // A REPEATING task on deck (2026-10-20): its deck is for its CURRENT
  // occurrence, with no target while decked. Re-enriching it must not compute
  // a fresh first occurrence (it has no `due_at`, so the rule branch would),
  // overwrite `occurrence_at`, or land a target beside the deck: the deck and
  // the occurrence are left alone, and so is every other date field.
  const answer =
    raced === 'dated'
      ? withoutDateFields(enrichment)
      : task.rrule && task.on_deck_day
        ? withoutDateFields(enrichment, 'a repeating task is on deck')
        : enrichment

  const changes = collectEnrichmentChanges(
    task,
    withEnrichmentRuleTime(
      task,
      deckOrTarget(task, withoutRuleOnDeadline(task, answer), user),
      user,
    ),
    user,
    inputText,
  )

  if (changes.fieldsChanged.length === 0) {
    // No field changes, but still need to remove ai-to-process label
    removeLabel(row.id, 'ai-to-process')
    log.info('ai', `Task ${row.id} enriched — no changes needed`)
    return []
  }

  const initial = isInitialEnrichment(user.id, row.id)

  // Add updated_at to the SET clauses
  changes.setClauses.push('updated_at = ?')
  changes.values.push(nowUtc())
  changes.values.push(row.id) // for WHERE clause

  withTransaction((txDb) => {
    const sql = `UPDATE tasks SET ${changes.setClauses.join(', ')} WHERE id = ?`
    txDb.prepare(sql).run(...changes.values)

    if (!initial) {
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
 * Is this the initial enrichment of a newly created task? Then the write gets
 * no undo entry of its own — undoing the 'create' soft-deletes the task, the
 * enriched version with it. A re-enrichment (the user adds `ai-to-process`
 * by hand) logs normally: that edit made a second undo entry (count > 1).
 */
function isInitialEnrichment(userId: number, taskId: number): boolean {
  const taskUndoCount = getDb()
    .prepare(
      `SELECT COUNT(*) as count FROM undo_log
       WHERE user_id = ?
       AND EXISTS (
         SELECT 1 FROM json_each(snapshot)
         WHERE json_extract(value, '$.task_id') = ?
       )`,
    )
    .get(userId, taskId) as { count: number }
  return taskUndoCount.count === 1
}

/**
 * Apply a QUOTA's enrichment (2026-10-24; plan §6). Not raw SQL like
 * `applyEnrichment`: the plan becomes an ordinary edit through
 * `collectFieldChanges` + `applyFieldChanges` — the same path a PATCH takes —
 * so every quota guard applies (`assertQuotaInvariants`, the re-anchor of a
 * changed period that carries a +1 logged meanwhile, `collectQuotaDateClear`,
 * `assertPromptSlotsOwned`), and the period is settled first
 * (`settleQuotaPeriod`) as `updateTask` does. A `ValidationError` from them
 * fails the enrichment (`handleFailure`: a retry, then `ai-failed`).
 *
 * Dropped whole when the user edited the row while the model ran (the label
 * is gone, `racedByUser`), and when the row is no longer a quota (converted
 * meanwhile: the answer was read for a kind it no longer is). No undo entry
 * on the initial enrichment, one on a re-enrichment — as `applyEnrichment`.
 * The callers emit the sync event, as they do for `applyEnrichment`.
 */
function applyQuotaEnrichment(
  row: PendingTaskRow,
  plan: QuotaEnrichmentPlan,
  user: { id: number; timezone: string },
): string[] {
  const found = getTaskById(row.id)
  if (!found) return []
  if (racedByUser(row, found) === 'edited') {
    log.info('ai', `Task ${row.id}: edited by the user while the model ran — not applied`)
    return []
  }
  if (!isTracked(found)) {
    log.info('ai', `Task ${row.id}: no longer a quota — its quota enrichment not applied`)
    removeLabel(row.id, 'ai-to-process')
    return []
  }

  const input = quotaEditFor(found, plan, user.id)
  const task = settleQuotaPeriod(found, input)
  const data = collectFieldChanges({ task, input, userId: user.id, userTimezone: user.timezone })
  if (data.fieldsChanged.length === 0) {
    removeLabel(row.id, 'ai-to-process')
    log.info('ai', `Task ${row.id} enriched — no changes needed`)
    return []
  }

  const initial = isInitialEnrichment(user.id, row.id)
  withTransaction((tx) => {
    const { snapshot } = applyFieldChanges(tx, task, data, nowUtc())
    if (!initial) {
      const changeList = data.fieldsChanged.filter((f) => !INTERNAL_FIELDS.includes(f)).join(', ')
      logAction(user.id, 'edit', `AI: Enriched quota — set ${changeList}`, data.fieldsChanged, [
        snapshot,
      ])
    }
  })

  log.info('ai', `Quota ${row.id} enriched: ${data.fieldsChanged.join(', ')}`)
  return data.fieldsChanged.filter((f) => !INTERNAL_FIELDS.includes(f))
}

/**
 * The quota plan as an edit of the stored row: only what differs, never a
 * clear (set-only). Labels merge (the trigger label always leaves; a label the
 * user stated is registered, as on the task path); the count comes with
 * `is_tracked: true`, so a target of 1 keeps it a quota; the reminder settings
 * merge over the stored config (`quotaPromptConfigFor`).
 */
function quotaEditFor(task: Task, plan: QuotaEnrichmentPlan, userId: number): FieldChangesInput {
  const input: FieldChangesInput = {}
  if (plan.title && plan.title !== task.title) input.title = plan.title
  if (plan.notes && plan.notes !== task.notes) input.notes = plan.notes
  if (plan.priority > 0 && plan.priority !== task.priority) input.priority = plan.priority

  const existing = new Set(task.labels)
  const creatable = filterAutoCreatableLabels(
    userId,
    plan.labels.filter((l) => !existing.has(l)),
  )
  validateLabelsExist(userId, creatable, [], true)
  const labels = [...task.labels, ...creatable].filter((l) => l !== 'ai-to-process')
  if (JSON.stringify(labels) !== JSON.stringify(task.labels)) input.labels = labels

  if (plan.rrule && plan.rrule !== task.rrule) input.rrule = plan.rrule
  if (plan.progress_target !== null && plan.progress_target !== task.progress_target) {
    input.progress_target = plan.progress_target
    input.is_tracked = true
  }
  const config = quotaPromptConfigFor(task.quota_prompt_config, plan)
  if (config && JSON.stringify(config) !== JSON.stringify(task.quota_prompt_config)) {
    input.quota_prompt_config = config
  }
  return input
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
  /** As claimed: a deck the user makes while the model runs must win (`racedByUser`). */
  on_deck_day?: string | null
  rrule: string | null
  is_reminder: number
  /** Quota enrichment (2026-10-24): routes the row to the quota prompt (`rowIsQuota`). */
  is_tracked: number
  progress_target: number
}

/** Is the claimed row a quota (`isTracked`, on the raw 0/1 column)? */
function rowIsQuota(row: Pick<PendingTaskRow, 'is_tracked' | 'progress_target'>): boolean {
  return isTracked({ is_tracked: row.is_tracked === 1, progress_target: row.progress_target })
}

/** The rows whose queue enrichment is announced to open tabs (`processEnrichmentQueue`). */
function isReminderOrQuota(row: PendingTaskRow): boolean {
  return row.is_reminder === 1 || rowIsQuota(row)
}
