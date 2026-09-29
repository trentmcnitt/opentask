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
import { getCurrentlyDueTaskIds } from './currently-due'

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
  'original_due_at',
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
  'snooze_count',
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
  return TASK_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ')
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
export function parseJsonColumn<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null
  } catch {
    return null
  }
}

export function rowToTask(row: TaskRow): Task {
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
