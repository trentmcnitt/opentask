/**
 * Task creation
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, TaskCreateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { computeFirstOccurrence, deriveAnchorFields } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent, emitTaskCreatedEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { getInboxId } from '@/core/projects'
import { syncBadgeCount } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { QUOTA_DUE_DATE_MESSAGE, QUOTA_PERIOD_MESSAGE } from '@/core/validation'
import { isTracked, quotaPeriodOf } from '@/lib/track'
import { assertPromptSlotsOwned, defaultReminderRule } from '@/core/time-slots'
import { getTaskById } from './read'
import { isAIEnabled } from '@/core/ai'
import { validateLabelsExist, PROVENANCE_LABELS } from '@/core/labels'

// The reads used to live here. Re-exported so existing `./create` imports keep
// working; new code imports from `./read`.
export { getTaskById, getTasks } from './read'
export type { GetTasksOptions, TaskKind } from './read'

export interface CreateTaskOptions {
  userId: number
  userTimezone: string
  input: TaskCreateInput
}

/**
 * A new quota's two refusals (§5): it has no due date (QUOTA_DUE_DATE_MESSAGE),
 * and it always has a period (QUOTA_PERIOD_MESSAGE, 2026-09-25).
 */
function assertQuotaShape(input: TaskCreateInput): void {
  if (input.due_at) throw new ValidationError(QUOTA_DUE_DATE_MESSAGE)
  if (quotaPeriodOf(input.rrule) === null) throw new ValidationError(QUOTA_PERIOD_MESSAGE)
}

/**
 * DEFAULT REMINDER SLOT (Trent, 2026-09-28: "Adding a reminder should be just
 * like adding a task"). A reminder created with no schedule — an Apple
 * Shortcut POSTing `{title, is_reminder: true}`, or the Reminders quick add —
 * lands at once in the user's default reminder slot, daily at its start
 * (`defaultReminderRule`), never in "Anytime". Enrichment still runs on it
 * (the ai-to-process trigger in createTask) and moves it if the text names a time or
 * cadence; if AI is off or enrichment fails, it stays in the default slot.
 *
 * Only an OMITTED rrule gets the default. An explicit `rrule: null` is the
 * reminder editor's one-time thought ("once"), a deliberate "no schedule",
 * and a caller-supplied rule ("FREQ=DAILY;BYHOUR=9") or due_at is respected
 * as sent. A user with no slots at all gets no default (null) — the
 * reminder stays unscheduled, as before.
 */
function scheduleFor(
  userId: number,
  input: TaskCreateInput,
  tracked: boolean,
): string | null | undefined {
  if (input.is_reminder !== true || input.rrule !== undefined || input.due_at || tracked) {
    return input.rrule
  }
  return defaultReminderRule(userId) ?? undefined
}

/**
 * Create a new task
 *
 * @returns The created task
 */
export function createTask(options: CreateTaskOptions): Task {
  const { userId, userTimezone, input } = options
  const db = getDb()

  // Get user's inbox project if no project_id specified
  let projectId = input.project_id
  if (!projectId) {
    const inboxId = getInboxId(userId)
    if (inboxId === null) {
      throw new Error('User inbox project not found')
    }
    projectId = inboxId
  }

  // Validate project exists and user has access
  const project = db
    .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
    .get(projectId) as { id: number; owner_id: number; shared: number } | undefined
  if (!project) {
    throw new NotFoundError('Project not found')
  }
  if (project.owner_id !== userId && project.shared !== 1) {
    throw new ForbiddenError('Access denied to project')
  }

  // §5: a quota is not a task — it has no due date (see QUOTA_DUE_DATE_MESSAGE).
  // Asked of the row being created, not of one field: `progress_target > 1`
  // opts in by itself, `is_tracked` marks a quota whose target is 1.
  const tracked = isTracked({
    is_tracked: input.is_tracked ?? false,
    progress_target: input.progress_target ?? 1,
  })
  if (tracked) assertQuotaShape(input)

  // Title-only is judged on what the CALLER sent, before the default reminder
  // schedule below fills in an rrule — otherwise a title-only reminder would
  // stop qualifying for enrichment the moment it got its default slot.
  const isTitleOnly =
    !input.due_at && (input.priority ?? 0) === 0 && !input.labels?.length && !input.rrule

  const rrule = scheduleFor(userId, input, tracked)

  // Compute due_at if rrule provided but no due_at.
  //
  // A quota is skipped: its rrule is a bare period rule ("FREQ=WEEKLY"), which
  // names the period the count runs over rather than a day to occur on, so
  // asking rrule.js for its "first occurrence" produced an arbitrary weekday —
  // which is how quotas ended up carrying a stray local-midnight due date.
  let dueAt = tracked ? null : (input.due_at ?? null)
  if (!tracked && rrule && !dueAt) {
    const firstOccurrence = computeFirstOccurrence(rrule, null, userTimezone)
    dueAt = firstOccurrence.toISOString()
  }

  // Derive anchor fields from rrule
  let anchorTime: string | null = null
  let anchorDow: number | null = null
  let anchorDom: number | null = null

  if (rrule) {
    const anchors = deriveAnchorFields(rrule, dueAt, userTimezone)
    anchorTime = anchors.anchor_time
    anchorDow = anchors.anchor_dow
    anchorDom = anchors.anchor_dom
  }

  const now = nowUtc()

  // If AI is enabled and the task is title-only (`isTitleOnly`, above), add the
  // ai-to-process trigger label.
  const taskLabels = [...(input.labels ?? [])]

  // §7.2: the registry gates labels the caller supplied. Check before the
  // machine-added labels below are appended — `ai-to-process` and the
  // provenance flags are ours, not the caller's, and holding them to the
  // "did you mean to create this?" rule would be nonsense.
  validateLabelsExist(userId, taskLabels, [], input.create_label === true)
  // The owner is the creator; nothing is stored yet, so every id is new.
  assertPromptSlotsOwned(userId, input.quota_prompt_config, null)

  // Provenance flags spare automated callers from typing behavior-bearing
  // labels as free text (§7.2).
  if (input.ai_proposed && !taskLabels.includes(PROVENANCE_LABELS.proposed)) {
    taskLabels.push(PROVENANCE_LABELS.proposed)
  }
  if (input.ai_added && !taskLabels.includes(PROVENANCE_LABELS.added)) {
    taskLabels.push(PROVENANCE_LABELS.added)
  }

  // `enrich` lets a caller opt in explicitly even when it sent structured
  // fields that disqualify it from title-only. (The Reminders quick add used to
  // need it for the schedule it sent; it now sends only the title and the
  // server's default slot does not count against title-only, but it still
  // sets `enrich` — harmless, and explicit about intent.)
  if (isAIEnabled() && (isTitleOnly || input.enrich === true)) {
    taskLabels.push('ai-to-process')
  }
  const labelsJson = JSON.stringify(taskLabels)

  // Execute insert and undo log in a transaction
  const createdTask = withTransaction((tx) => {
    // Insert the task
    // Set original_due_at = due_at when creating with a due date, so the field
    // always tracks the "occurrence origin" timestamp (not just snooze state).
    const result = tx
      .prepare(
        `
      INSERT INTO tasks (
        user_id, project_id, title, original_title, short_title, done, priority, due_at, original_due_at,
        rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
        auto_snooze_minutes, labels, notes, progress_target, is_reminder, is_tracked,
        quota_prompt_config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        userId,
        projectId,
        input.title,
        input.title, // original_title — preserve raw input for enrichment retry
        input.short_title ?? null,
        input.priority ?? 0,
        dueAt,
        dueAt, // original_due_at = due_at (null if no due date)
        rrule ?? null,
        input.recurrence_mode ?? 'from_due',
        anchorTime,
        anchorDow,
        anchorDom,
        input.auto_snooze_minutes ?? null,
        labelsJson,
        input.notes ?? null,
        // §5: setting a target above 1 at creation is the whole opt-in gesture.
        input.progress_target ?? 1,
        input.is_reminder ? 1 : 0,
        input.is_tracked ? 1 : 0,
        // NULL unless the caller chose: "the defaults for its period" must stay
        // representable, so a YEARLY quota is off and a weekly one on without
        // anything being baked in at creation.
        input.quota_prompt_config ? JSON.stringify(input.quota_prompt_config) : null,
        now,
        now,
      )

    const taskId = Number(result.lastInsertRowid)

    // Fetch the created task
    const task = getTaskById(taskId)
    if (!task) {
      throw new Error('Failed to retrieve created task')
    }

    // Log to undo - for create, before_state is empty, after_state is the task
    // On undo, we'll soft-delete the task
    const snapshot = createTaskSnapshot(
      { id: taskId }, // before_state is essentially empty
      task,
      ['id', 'title', 'project_id', 'due_at', 'rrule', 'priority', 'labels', 'notes'],
    )

    logAction(userId, 'create', `Created "${input.title}"`, ['created'], [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'create',
      fields: snapshot.after_state
        ? Object.keys(snapshot.after_state).filter((k) => k !== 'id')
        : [],
      after: snapshot.after_state,
    })

    // Increment daily stats
    incrementDailyStat(userId, 'tasks_created', userTimezone)

    return task
  })

  emitSyncEvent(userId)
  emitTaskCreatedEvent(userId, { taskId: createdTask.id, title: createdTask.title })
  syncBadgeIfBornOverdue(userId, createdTask)
  dispatchWebhookEvent(userId, 'task.created', { task: formatTaskResponse(createdTask) })

  return createdTask
}

/**
 * A task created already overdue changes the app-icon badge now; without this
 * the badge would wait for the overdue checker's next run.
 */
function syncBadgeIfBornOverdue(userId: number, task: Task): void {
  if (task.due_at && new Date(task.due_at) < new Date()) syncBadgeCount(userId)
}
