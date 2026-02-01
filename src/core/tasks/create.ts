/**
 * Task creation
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, TaskCreateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { computeFirstOccurrence, deriveAnchorFields } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'

export interface CreateTaskOptions {
  userId: number
  userTimezone: string
  input: TaskCreateInput
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
    throw new Error('Project not found')
  }
  if (project.owner_id !== userId && project.shared !== 1) {
    throw new Error('Access denied to project')
  }

  // Compute due_at if rrule provided but no due_at
  let dueAt = input.due_at ?? null
  if (input.rrule && !dueAt) {
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
  const labelsJson = JSON.stringify(input.labels ?? [])

  // Execute insert and undo log in a transaction
  return withTransaction((tx) => {
    // Insert the task
    const result = tx
      .prepare(
        `
      INSERT INTO tasks (
        user_id, project_id, title, done, priority, due_at,
        rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
        labels, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        userId,
        projectId,
        input.title,
        input.priority ?? 0,
        dueAt,
        input.rrule ?? null,
        input.recurrence_mode ?? 'from_due',
        anchorTime,
        anchorDow,
        anchorDom,
        labelsJson,
        now,
        now
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
      ['id', 'title', 'project_id', 'due_at', 'rrule', 'priority', 'labels']
    )

    logAction(userId, 'create', `Created "${input.title}"`, ['created'], [snapshot])

    return task
  })
}

/**
 * Get a task by ID
 */
export function getTaskById(taskId: number): Task | null {
  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT id, user_id, project_id, title, done, done_at, priority, due_at,
           rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
           snoozed_from, deleted_at, archived_at, labels, created_at, updated_at
    FROM tasks WHERE id = ?
  `
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
export interface GetTasksOptions {
  userId: number
  projectId?: number
  done?: boolean
  overdue?: boolean
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

  // Filter by overdue
  if (options.overdue) {
    conditions.push("tasks.due_at IS NOT NULL AND tasks.due_at < datetime('now')")
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

  // Search by title
  if (options.search) {
    conditions.push('tasks.title LIKE ?')
    params.push(`%${options.search}%`)
  }

  // Filter by label
  if (options.label) {
    conditions.push("tasks.labels LIKE ?")
    params.push(`%"${options.label}"%`)
  }

  // Add pagination
  params.push(limit, offset)

  const sql = `
    SELECT tasks.id, tasks.user_id, tasks.project_id, tasks.title, tasks.done,
           tasks.done_at, tasks.priority, tasks.due_at,
           tasks.rrule, tasks.recurrence_mode, tasks.anchor_time,
           tasks.anchor_dow, tasks.anchor_dom, tasks.snoozed_from,
           tasks.deleted_at, tasks.archived_at, tasks.labels,
           tasks.created_at, tasks.updated_at
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
  done: number
  done_at: string | null
  priority: number
  due_at: string | null
  rrule: string | null
  recurrence_mode: string
  anchor_time: string | null
  anchor_dow: number | null
  anchor_dom: number | null
  snoozed_from: string | null
  deleted_at: string | null
  archived_at: string | null
  labels: string
  created_at: string
  updated_at: string
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
    title: row.title,
    done: row.done === 1,
    done_at: row.done_at,
    priority: row.priority,
    due_at: row.due_at,
    rrule: row.rrule,
    recurrence_mode: row.recurrence_mode as 'from_due' | 'from_completion',
    anchor_time: row.anchor_time,
    anchor_dow: row.anchor_dow,
    anchor_dom: row.anchor_dom,
    snoozed_from: row.snoozed_from,
    deleted_at: row.deleted_at,
    archived_at: row.archived_at,
    labels: JSON.parse(row.labels),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
