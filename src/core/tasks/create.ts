/**
 * Task creation
 */

import { getDb, withTransaction } from '@/core/db'
import type { QuotaDayState, QuotaPromptConfig, Task, TaskCreateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { computeFirstOccurrence, deriveAnchorFields } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent, emitTaskCreatedEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { QUOTA_DUE_DATE_MESSAGE, QUOTA_PERIOD_MESSAGE } from '@/core/validation'
import { isTracked, quotaPeriodOf } from '@/lib/track'
import { normalizeDayState } from '@/lib/quota-prompts'
import { assertPromptSlotsOwned } from '@/core/time-slots'
import { getCurrentlyDueTaskIds } from './currently-due'
import { isAIEnabled } from '@/core/ai'
import { validateLabelsExist, PROVENANCE_LABELS } from '@/core/labels'

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
    const inbox = db
      .prepare('SELECT id FROM projects WHERE owner_id = ? AND name = ?')
      .get(userId, 'Inbox') as { id: number } | undefined
    if (!inbox) {
      throw new Error('User inbox project not found')
    }
    projectId = inbox.id
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

  // Compute due_at if rrule provided but no due_at.
  //
  // A quota is skipped: its rrule is a bare period rule ("FREQ=WEEKLY"), which
  // names the period the count runs over rather than a day to occur on, so
  // asking rrule.js for its "first occurrence" produced an arbitrary weekday —
  // which is how quotas ended up carrying a stray local-midnight due date.
  let dueAt = tracked ? null : (input.due_at ?? null)
  if (!tracked && input.rrule && !dueAt) {
    const firstOccurrence = computeFirstOccurrence(input.rrule, null, userTimezone)
    dueAt = firstOccurrence.toISOString()
  }

  // Derive anchor fields from rrule
  let anchorTime: string | null = null
  let anchorDow: number | null = null
  let anchorDom: number | null = null

  if (input.rrule) {
    const anchors = deriveAnchorFields(input.rrule, dueAt, userTimezone)
    anchorTime = anchors.anchor_time
    anchorDow = anchors.anchor_dow
    anchorDom = anchors.anchor_dom
  }

  const now = nowUtc()

  // If AI is enabled and the task is title-only, add the ai-to-process trigger label
  const isTitleOnly =
    !input.due_at && (input.priority ?? 0) === 0 && !input.labels?.length && !input.rrule
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

  // `enrich` lets a caller opt in explicitly: the Reminders quick add sends a
  // default schedule so the row appears in a slot at once, which makes it look
  // structured even though the user only typed a sentence.
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
        input.rrule ?? null,
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
  dispatchWebhookEvent(userId, 'task.created', { task: formatTaskResponse(createdTask) })

  return createdTask
}

/**
 * Get a task by ID
 */
export function getTaskById(taskId: number): Task | null {
  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT id, user_id, project_id, title, original_title, short_title, done, done_at, priority, due_at,
           rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
           original_due_at, last_notified_at, last_critical_alert_at, auto_snooze_minutes,
           deleted_at, archived_at, labels,
           progress_target, progress_current, progress_period_start, is_reminder, is_tracked,
           quota_prompt_config, quota_day_state,
           completion_count, snooze_count, skip_count, first_completed_at, last_completed_at,
           notes, created_at, updated_at
    FROM tasks WHERE id = ?
  `,
    )
    .get(taskId) as TaskRow | undefined

  if (!row) {
    return null
  }

  return rowToTask(row)
}

/**
 * Get tasks with filters
 */
export type TaskKind = 'task' | 'reminder' | 'quota'

export interface GetTasksOptions {
  userId: number
  projectId?: number
  done?: boolean
  /** Only the badge's "currently due" set — see `getCurrentlyDueTaskIds`. */
  overdue?: boolean
  /** One population: ordinary tasks, reminders (§6), or quotas (§5). */
  kind?: TaskKind
  recurring?: boolean
  oneOff?: boolean
  search?: string
  label?: string
  trashed?: boolean
  archived?: boolean
  limit?: number
  offset?: number
}

export function getTasks(options: GetTasksOptions): Task[] {
  const db = getDb()
  const { userId, limit = 200, offset = 0 } = options

  const conditions: string[] = []
  const params: unknown[] = []

  // Base condition: user's tasks OR tasks in shared projects
  conditions.push(`(tasks.user_id = ? OR projects.shared = 1)`)
  params.push(userId)

  // Filter by project
  if (options.projectId !== undefined) {
    conditions.push('tasks.project_id = ?')
    params.push(options.projectId)
  }

  // Filter by done status
  if (options.done !== undefined) {
    conditions.push('tasks.done = ?')
    params.push(options.done ? 1 : 0)
  } else {
    // Default: only undone tasks
    conditions.push('tasks.done = 0')
  }

  // Filter by trashed
  if (options.trashed) {
    conditions.push('tasks.deleted_at IS NOT NULL')
  } else {
    conditions.push('tasks.deleted_at IS NULL')
  }

  // Filter by archived
  if (options.archived) {
    conditions.push('tasks.archived_at IS NOT NULL')
  } else if (!options.done) {
    // If not explicitly asking for done tasks, exclude archived
    conditions.push('tasks.archived_at IS NULL')
  }

  // Filter by kind — the three populations the app keeps on separate surfaces.
  // Same predicates as everywhere else: a quota is `isTracked` (flag OR target
  // > 1, period-rollover's exact SQL), a reminder is `is_reminder`, a task is
  // neither. SQL, so it applies BEFORE the LIMIT/OFFSET below.
  if (options.kind === 'quota') {
    conditions.push('(tasks.is_tracked = 1 OR tasks.progress_target > 1)')
  } else if (options.kind === 'reminder') {
    conditions.push('tasks.is_reminder = 1')
  } else if (options.kind === 'task') {
    conditions.push('tasks.is_reminder = 0 AND tasks.is_tracked = 0 AND tasks.progress_target <= 1')
  }

  // Filter by overdue — the BADGE's definition, not a hand-rolled `due_at < now`.
  //
  // It used to be exactly that, which counted reminders (§6: no debt, never
  // overdue) and read a recurring task's frozen due_at as the truth, while the
  // badge, the notifier and the snooze-overdue sweep all exclude reminders and
  // quotas and derive due-ness from the schedule. `currently-due.ts` is the one
  // place that answers "what is due right now"; this asks it. An id list, so
  // pagination still applies after the filter.
  //
  // Scope: `getCurrentlyDueTaskIds` is the user's OWN tasks (the badge's
  // population), so a shared-project task owned by someone else never matches
  // `overdue=true` — it is not on this user's badge either.
  if (options.overdue) {
    const dueIds = getCurrentlyDueTaskIds(userId)
    conditions.push('tasks.id IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(dueIds))
  }

  // Filter by recurring
  if (options.recurring !== undefined) {
    if (options.recurring) {
      conditions.push('tasks.rrule IS NOT NULL')
    } else {
      conditions.push('tasks.rrule IS NULL')
    }
  }

  // Filter by one-off (alias for !recurring)
  if (options.oneOff) {
    conditions.push('tasks.rrule IS NULL')
  }

  // Search by title and notes — escape SQL LIKE wildcards so literal % and _ in
  // the search term don't act as wildcards
  if (options.search) {
    const escaped = options.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    conditions.push("(tasks.title LIKE ? ESCAPE '\\' OR tasks.notes LIKE ? ESCAPE '\\')")
    params.push(`%${escaped}%`, `%${escaped}%`)
  }

  // Filter by label
  if (options.label) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE value = ?)')
    params.push(options.label)
  }

  // Add pagination
  params.push(limit, offset)

  const sql = `
    SELECT tasks.id, tasks.user_id, tasks.project_id, tasks.title,
           tasks.original_title, tasks.short_title, tasks.done,
           tasks.done_at, tasks.priority, tasks.due_at,
           tasks.rrule, tasks.recurrence_mode, tasks.anchor_time,
           tasks.anchor_dow, tasks.anchor_dom, tasks.original_due_at,
           tasks.last_notified_at, tasks.last_critical_alert_at, tasks.auto_snooze_minutes,
           tasks.deleted_at, tasks.archived_at,
           tasks.labels, tasks.progress_target, tasks.progress_current,
           tasks.progress_period_start, tasks.is_reminder, tasks.is_tracked,
           tasks.quota_prompt_config, tasks.quota_day_state,
           tasks.completion_count, tasks.snooze_count, tasks.skip_count,
           tasks.first_completed_at, tasks.last_completed_at,
           tasks.notes, tasks.created_at, tasks.updated_at
    FROM tasks
    INNER JOIN projects ON tasks.project_id = projects.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY tasks.due_at ASC NULLS LAST, tasks.priority DESC, tasks.id ASC
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(sql).all(...params) as TaskRow[]
  return rows.map(rowToTask)
}

// Internal types for database rows
interface TaskRow {
  id: number
  user_id: number
  project_id: number
  title: string
  original_title: string | null
  short_title: string | null
  done: number
  done_at: string | null
  priority: number
  due_at: string | null
  rrule: string | null
  recurrence_mode: string
  anchor_time: string | null
  anchor_dow: number | null
  anchor_dom: number | null
  original_due_at: string | null
  last_notified_at: string | null
  last_critical_alert_at: string | null
  auto_snooze_minutes: number | null
  deleted_at: string | null
  archived_at: string | null
  labels: string
  progress_target: number
  progress_current: number
  progress_period_start: string | null
  is_reminder: number
  is_tracked: number
  quota_prompt_config: string | null
  quota_day_state: string | null
  completion_count: number
  snooze_count: number
  skip_count: number
  first_completed_at: string | null
  last_completed_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/**
 * A server-owned JSON column. A malformed value reads as NULL — "the
 * defaults" / "an empty day" — rather than throwing: one bad row must not
 * take down every list that loads it.
 */
function parseJsonColumn<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null
  } catch {
    return null
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
    title: row.title,
    original_title: row.original_title,
    short_title: row.short_title,
    done: row.done === 1,
    done_at: row.done_at,
    priority: row.priority,
    due_at: row.due_at,
    rrule: row.rrule,
    recurrence_mode: row.recurrence_mode as 'from_due' | 'from_completion',
    anchor_time: row.anchor_time,
    anchor_dow: row.anchor_dow,
    anchor_dom: row.anchor_dom,
    original_due_at: row.original_due_at,
    last_notified_at: row.last_notified_at,
    last_critical_alert_at: row.last_critical_alert_at,
    auto_snooze_minutes: row.auto_snooze_minutes,
    deleted_at: row.deleted_at,
    archived_at: row.archived_at,
    labels: JSON.parse(row.labels),
    // §5/§7.5: defaulted rather than asserted — a row read before the
    // migration applied (or from a hand-written fixture) would otherwise
    // produce NaN in pace math.
    progress_target: row.progress_target ?? 1,
    progress_current: row.progress_current ?? 0,
    progress_period_start: row.progress_period_start ?? null,
    is_reminder: (row.is_reminder ?? 0) === 1,
    is_tracked: (row.is_tracked ?? 0) === 1,
    quota_prompt_config: parseJsonColumn<QuotaPromptConfig>(row.quota_prompt_config),
    quota_day_state: normalizeDayState(parseJsonColumn<QuotaDayState>(row.quota_day_state)),
    completion_count: row.completion_count,
    snooze_count: row.snooze_count,
    skip_count: row.skip_count ?? 0,
    first_completed_at: row.first_completed_at,
    last_completed_at: row.last_completed_at,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
