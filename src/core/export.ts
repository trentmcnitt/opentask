/**
 * Data export module
 *
 * Exports user data (tasks, projects, completions) in JSON or CSV format.
 */

import { getDb } from '@/core/db'
import { getProjects } from '@/core/projects'
import { formatTaskResponse, type FormattedTask } from '@/lib/format-task'
import type { Project, Task } from '@/types'

interface Completion {
  id: number
  task_id: number
  user_id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
}

interface ExportData {
  tasks: FormattedTask[]
  projects: Project[]
  completions: Completion[]
}

/** Raw task row from SQLite before type conversion (done is integer, labels is JSON string) */
interface TaskRow extends Omit<Task, 'done' | 'labels' | 'recurrence_mode'> {
  done: number
  labels: string
  recurrence_mode: string
}

/**
 * Export all user data: tasks (active, done, archived, trashed), projects, and completions.
 *
 * Uses a direct DB query instead of getTasks() to guarantee no filter gaps.
 * getTasks() applies complex default filters (done=0, deleted_at IS NULL, etc.)
 * that can miss edge-case states like done+trashed or done-but-not-archived tasks.
 */
export function exportUserData(userId: number): ExportData {
  const db = getDb()

  // Direct query: all tasks belonging to this user, regardless of state
  const allRawTasks = db
    .prepare(
      `SELECT id, user_id, project_id, title, original_title, done, done_at, priority,
              due_at, rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
              original_due_at, deleted_at, archived_at, labels,
              last_notified_at, last_critical_alert_at, auto_snooze_minutes,
              completion_count, snooze_count, first_completed_at, last_completed_at,
              notes, created_at, updated_at
       FROM tasks
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 10000`,
    )
    .all(userId) as TaskRow[]

  // Convert raw DB rows to typed Task objects (matches rowToTask pattern in create.ts)
  const allTasks: FormattedTask[] = allRawTasks.map((row) => {
    const task: Task = {
      ...row,
      done: row.done === 1,
      labels: JSON.parse(row.labels),
      recurrence_mode: row.recurrence_mode as 'from_due' | 'from_completion',
    }
    return formatTaskResponse(task)
  })

  const projects = getProjects(userId)

  const completions = db
    .prepare(
      'SELECT id, task_id, user_id, completed_at, due_at_was, due_at_next FROM completions WHERE user_id = ? ORDER BY completed_at DESC',
    )
    .all(userId) as Completion[]

  return { tasks: allTasks, projects, completions }
}

/**
 * Prefix a cell value with a single quote if it starts with a formula-injection character.
 * Prevents CSV injection when opened in spreadsheet applications.
 */
function sanitizeCell(value: string): string {
  if (
    value.length > 0 &&
    (value[0] === '=' ||
      value[0] === '+' ||
      value[0] === '-' ||
      value[0] === '@' ||
      value[0] === '\t' ||
      value[0] === '\r')
  ) {
    return "'" + value
  }
  return value
}

/**
 * Escape and quote a CSV field: double internal quotes, wrap in quotes.
 */
function csvField(value: string | number | boolean | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value)
  const sanitized = sanitizeCell(str)
  return '"' + sanitized.replace(/"/g, '""') + '"'
}

/**
 * Convert formatted tasks to CSV string.
 */
export function tasksToCsv(tasks: FormattedTask[]): string {
  const columns = [
    'id',
    'title',
    'done',
    'priority',
    'due_at',
    'rrule',
    'project_id',
    'labels',
    'notes',
    'created_at',
    'updated_at',
    'is_recurring',
    'is_snoozed',
    'deleted_at',
    'archived_at',
  ] as const

  const header = columns.map((c) => csvField(c)).join(',')

  const rows = tasks.map((task) => {
    const values = columns.map((col) => {
      if (col === 'labels') {
        return csvField(task.labels.join(';'))
      }
      return csvField(task[col])
    })
    return values.join(',')
  })

  return [header, ...rows].join('\n')
}

/**
 * Convert projects to CSV string.
 */
export function projectsToCsv(projects: Project[]): string {
  const columns = [
    'id',
    'name',
    'sort_order',
    'color',
    'active_count',
    'overdue_count',
    'created_at',
  ] as const

  const header = columns.map((c) => csvField(c)).join(',')

  const rows = projects.map((project) => {
    const values = columns.map((col) => csvField(project[col]))
    return values.join(',')
  })

  return [header, ...rows].join('\n')
}
