/**
 * Task reads: the single-row lookup (`getTaskById`), the filtered list
 * (`getTasks`), and the row → `Task` mapping both share.
 *
 * Neither read checks access — `getTaskById` returns any user's row, and
 * `getTasks` scopes by owner/shared project in its WHERE. A mutation loads and
 * guards its task through `loadTaskForMutation` (`./access`).
 */

import { getDb } from '@/core/db'
import type { QuotaDayState, QuotaPromptConfig, Task } from '@/types'
import { normalizeDayState } from '@/lib/quota-prompts'
import {
  effectiveAttempts,
  hasRepeatEnd,
  isLastOccurrence,
  repeatRemaining,
} from '@/lib/task-segments'
import { quotaPeriodFields } from '@/lib/track'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { DEFAULT_DAY_START } from '@/lib/anchor-times'
import { coerceWeekStart } from '@/lib/week-start'
import { getCurrentlyDueTaskIds } from './currently-due'
import { taskQueueEnabled } from './task-queue'

/**
 * Every column `rowToTask` reads, in one list so the two SELECTs below can't
 * drift apart.
 */
const TASK_COLUMNS = [
  'id',
  'user_id',
  'project_id',
  'title',
  'original_title',
  'short_title',
  'done',
  'done_at',
  'priority',
  'due_at',
  'rrule',
  'recurrence_mode',
  'anchor_time',
  'anchor_dow',
  'anchor_dom',
  'repeat_anchor',
  'target_days_before',
  'target_time',
  'target_slot_id',
  'repeat_count',
  'repeat_count_used',
  'repeat_until',
  'original_due_at',
  'deadline_at',
  'horizon',
  'horizon_set_at',
  'last_considered_at',
  'segment_deferred_at',
  'segment_targeted_at',
  'target_set_at',
  'target_auto',
  'occurrence_at',
  'attempts',
  'attempts_counted_through',
  'growth_kept_at',
  'queue_mark',
  'try_tomorrow',
  'queued_at',
  'queued_from_due_at',
  'rolled_over_at',
  'on_deck_day',
  'queued_from_deck_day',
  'lead_days',
  'lead_from',
  'last_notified_at',
  'last_critical_alert_at',
  'auto_snooze_minutes',
  'deleted_at',
  'archived_at',
  'labels',
  'progress_target',
  'progress_current',
  'progress_period_start',
  'is_reminder',
  'is_tracked',
  'quota_prompt_config',
  'quota_day_state',
  'completion_count',
  'skip_count',
  'first_completed_at',
  'last_completed_at',
  'notes',
  'created_at',
  'updated_at',
] as const

/**
 * The SELECT list for a full task row. `alias` qualifies each column
 * (`tasks.id`) for a query that joins a table with overlapping names —
 * `getTasks` joins `projects`, which has its own `id`.
 */
export function taskColumns(alias?: string): string {
  const table = alias ?? 'tasks'
  // The OWNER's timezone, for the attempts read (`effectiveAttempts`): a
  // local day is the owner's, whoever reads a shared task.
  const ownerTz = `(SELECT timezone FROM users WHERE users.id = ${table}.user_id) AS owner_timezone`
  // And the owner's first day of the week, for a quota's served period
  // (`quotaPeriodFields`): a week ends at the owner's boundary, like the rollover.
  const ownerWeekStart = `(SELECT week_start FROM users WHERE users.id = ${table}.user_id) AS owner_week_start`
  // And the owner's ROLLOVER TIME (task queue, 2026-10-19): their "Day
  // starts at" (2026-10-23) — `dayStartTimeOf` in SQL, in its order: a live
  // link's period start; the stored time (a custom time, or a gone link's
  // snapshot); unset, the fixed default (`DEFAULT_DAY_START`, 3:00 AM —
  // 2026-10-24). Read only with the switch on, when attempts count OpenTask
  // days (`effectiveAttempts`).
  const ownerRollover = `COALESCE((SELECT s.start_time FROM users u JOIN time_slots s ON s.id = u.day_start_slot_id AND s.user_id = u.id WHERE u.id = ${table}.user_id),(SELECT day_start_time FROM users WHERE users.id = ${table}.user_id),'${DEFAULT_DAY_START}') AS owner_rollover_time`
  return [
    ...TASK_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)),
    ownerTz,
    ownerWeekStart,
    ownerRollover,
  ].join(', ')
}

/**
 * Get a task by ID
 */
export function getTaskById(taskId: number): Task | null {
  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT ${taskColumns()}
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
  /** true: only tasks with a stored target (`due_at`); false: only tasks without one. */
  hasTarget?: boolean
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

  if (options.hasTarget !== undefined) {
    conditions.push(options.hasTarget ? 'tasks.due_at IS NOT NULL' : 'tasks.due_at IS NULL')
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
    SELECT ${taskColumns('tasks')}
    FROM tasks
    INNER JOIN projects ON tasks.project_id = projects.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY tasks.due_at ASC NULLS LAST, tasks.priority DESC, tasks.id ASC
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(sql).all(...params) as TaskRow[]
  return rows.map(rowToTask)
}

/** A `tasks` row as SQLite returns it, before `rowToTask`. */
export interface TaskRow {
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
  repeat_anchor?: string | null
  target_days_before?: number | null
  target_time?: string | null
  target_slot_id?: number | null
  repeat_count?: number | null
  repeat_count_used?: number | null
  repeat_until?: string | null
  original_due_at: string | null
  deadline_at: string | null
  horizon: string | null
  horizon_set_at: string | null
  last_considered_at: string | null
  segment_deferred_at: string | null
  segment_targeted_at: string | null
  target_set_at: string | null
  target_auto: number
  occurrence_at: string | null
  attempts: number
  attempts_counted_through: string | null
  growth_kept_at: string | null
  queue_mark?: number
  try_tomorrow?: number
  queued_at?: string | null
  queued_from_due_at?: string | null
  rolled_over_at?: string | null
  on_deck_day?: string | null
  queued_from_deck_day?: string | null
  lead_days?: number | null
  lead_from?: string | null
  /** Not a column: the owner's rollover time (`taskColumns`), for the attempts read. */
  owner_rollover_time?: string | null
  /** Not a column: the owner's timezone (`taskColumns`), for the attempts read. */
  owner_timezone?: string | null
  /** Not a column: the owner's `week_start` (`taskColumns`), for a quota's served period. */
  owner_week_start?: string | null
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
export function parseJsonColumn<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null
  } catch {
    return null
  }
}

/**
 * A row as a `Task`. ATTEMPTS ARE READ AS OF NOW (spec §7): the stored
 * checkpoint plus the over-target local days since (`effectiveAttempts`, in
 * the owner's zone), so every reader — the API, the snapshot a mutation takes,
 * the checkpoint a move writes — sees the same count without waiting for the
 * minute cron. A row read without `owner_timezone` keeps the stored values.
 */
export function rowToTask(row: TaskRow): Task {
  const task = baseTask(row)
  if (row.owner_timezone) {
    // Task queue (B7): with the switch on, an attempt is an OPENTASK day
    // (rollover to rollover), not a calendar day.
    const rolloverTime = taskQueueEnabled() ? (row.owner_rollover_time ?? null) : null
    const { attempts, countedThrough } = effectiveAttempts(
      task,
      row.owner_timezone,
      new Date(),
      rolloverTime,
    )
    task.attempts = attempts
    task.attempts_counted_through = countedThrough
    // Repeat ends (2026-10-22): judged in the owner's zone, only on a row
    // with an end. A count is arithmetic; a date end asks the engine once
    // (`isLastOccurrence`).
    if (hasRepeatEnd(task)) {
      task.repeat_last = isLastOccurrence(
        task,
        row.owner_timezone,
        new Date(),
        rolloverTime ?? CALENDAR_DAY_START,
      )
      task.repeat_remaining = repeatRemaining(task)
    }
    // Interval quotas (2026-10-16): the current period, served — see
    // `quotaPeriodFields`. Every row carries the four keys (null on anything
    // but a quota), so the response has one shape.
    Object.assign(
      task,
      quotaPeriodFields(
        task,
        row.owner_timezone,
        new Date(),
        coerceWeekStart(row.owner_week_start),
        // A daily quota's day ends at the owner's day start with the queue's
        // switch on (2026-10-23, `dayBoundaryForUser`'s rule), else midnight.
        rolloverTime ?? CALENDAR_DAY_START,
      ),
    )
  }
  return task
}

/** The task queue's columns (2026-10-19); defaulted for a row from before them. */
function queueFields(
  row: TaskRow,
): Pick<
  Task,
  | 'queue_mark'
  | 'try_tomorrow'
  | 'queued_at'
  | 'queued_from_due_at'
  | 'rolled_over_at'
  | 'on_deck_day'
  | 'queued_from_deck_day'
  | 'lead_days'
  | 'lead_from'
> {
  return {
    queue_mark: row.queue_mark === 1,
    try_tomorrow: row.try_tomorrow === 1,
    queued_at: row.queued_at ?? null,
    queued_from_due_at: row.queued_from_due_at ?? null,
    rolled_over_at: row.rolled_over_at ?? null,
    on_deck_day: row.on_deck_day ?? null,
    queued_from_deck_day: row.queued_from_deck_day ?? null,
    lead_days: row.lead_days ?? null,
    lead_from: row.lead_from ?? null,
  }
}

/** A repeating task's anchor and relative target (2026-10-21, `Task.repeat_anchor`). */
function repeatFields(
  row: TaskRow,
): Pick<
  Task,
  | 'repeat_anchor'
  | 'target_days_before'
  | 'target_time'
  | 'target_slot_id'
  | 'repeat_count'
  | 'repeat_count_used'
  | 'repeat_until'
> {
  return {
    repeat_anchor: row.repeat_anchor === 'deadline' ? 'deadline' : 'target',
    target_days_before: row.target_days_before ?? null,
    target_time: row.target_time ?? null,
    target_slot_id: row.target_slot_id ?? null,
    // Repeat ends (2026-10-22): defaulted for a row from before the columns.
    repeat_count: row.repeat_count ?? null,
    repeat_count_used: row.repeat_count_used ?? 0,
    repeat_until: row.repeat_until ?? null,
  }
}

function baseTask(row: TaskRow): Task {
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
    ...repeatFields(row),
    original_due_at: row.original_due_at,
    deadline_at: row.deadline_at ?? null,
    horizon: (row.horizon ?? null) as Task['horizon'],
    horizon_set_at: row.horizon_set_at ?? null,
    last_considered_at: row.last_considered_at ?? null,
    segment_deferred_at: row.segment_deferred_at ?? null,
    segment_targeted_at: row.segment_targeted_at ?? null,
    target_set_at: row.target_set_at ?? null,
    target_auto: (row.target_auto ?? 0) === 1,
    occurrence_at: row.occurrence_at ?? null,
    attempts: row.attempts ?? 0,
    attempts_counted_through: row.attempts_counted_through ?? null,
    growth_kept_at: row.growth_kept_at ?? null,
    ...queueFields(row),
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
    skip_count: row.skip_count ?? 0,
    first_completed_at: row.first_completed_at,
    last_completed_at: row.last_completed_at,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
