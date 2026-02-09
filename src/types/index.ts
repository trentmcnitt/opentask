// Core domain types for OpenTask

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray'

export interface LabelConfig {
  name: string
  color: LabelColor
}

export interface PriorityDisplayConfig {
  trailingDot: boolean // Show ● after title for Medium/Low
  colorTitle: boolean // Color task title based on priority
  rightBorder: boolean // Show colored right border
}

export interface Project {
  id: number
  name: string
  owner_id: number
  shared: boolean
  sort_order: number
  active_count: number
  overdue_count: number
  created_at: string
}

export interface Task {
  id: number
  user_id: number
  project_id: number
  title: string
  done: boolean
  done_at: string | null
  priority: number // 0=unset, 1=low, 2=medium, 3=high, 4=urgent
  due_at: string | null

  // Recurrence
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion'
  anchor_time: string | null // HH:MM in user's local timezone
  anchor_dow: number | null // 0=Mon..6=Sun
  anchor_dom: number | null // 1-31

  // Snooze tracking (stores the original due_at when task is first snoozed)
  original_due_at: string | null

  // Notifications
  last_notified_at: string | null
  auto_snooze_minutes: number | null

  // Soft delete and archive
  deleted_at: string | null
  archived_at: string | null

  // Labels
  labels: string[]

  // Per-task stats (survive beyond completions retention)
  completion_count: number
  snooze_count: number
  first_completed_at: string | null
  last_completed_at: string | null
  meta_notes: string | null

  // AI enrichment status
  ai_status: 'pending' | 'processing' | 'complete' | 'failed' | null

  created_at: string
  updated_at: string
}

export interface Note {
  id: number
  task_id: number
  content: string
  created_at: string
}

export interface UndoLogEntry {
  id: number
  user_id: number
  action: UndoAction
  description: string | null
  fields_changed: string[] // JSON array of field names
  snapshot: UndoSnapshot[] // JSON array
  created_at: string
  undone: boolean
}

export interface DailyStat {
  id: number
  user_id: number
  date: string // YYYY-MM-DD in user's timezone
  completions: number
  tasks_created: number
  snoozes: number
}

export interface StatsSummary {
  today: DailyStat | null
  week: {
    completions: number
    tasks_created: number
    snoozes: number
  }
  month: {
    completions: number
    tasks_created: number
    snoozes: number
  }
  all_time: {
    completions: number
    tasks_created: number
    snoozes: number
  }
}

export type UndoAction =
  | 'done'
  | 'undone'
  | 'snooze'
  | 'edit'
  | 'delete'
  | 'create'
  | 'restore'
  | 'bulk_done'
  | 'bulk_snooze'
  | 'bulk_edit'
  | 'bulk_delete'

export interface UndoSnapshot {
  task_id: number
  before_state: Partial<Task>
  after_state: Partial<Task>
  completion_id?: number // For recurring task done - tracks the completion record to delete on undo
}

// API input types — canonical definitions live in @/core/validation/task (Zod schemas)
export type {
  TaskCreateInput,
  TaskUpdateInput,
  SnoozeInput,
  BulkDoneInput,
  BulkSnoozeInput,
  BulkEditInput,
  BulkDeleteInput,
} from '@/core/validation/task'

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export interface UndoResult {
  undone_action: UndoAction
  description: string | null
  tasks_affected: number
}

export interface RedoResult {
  redone_action: UndoAction
  description: string | null
  tasks_affected: number
}

// Auth types
export interface AuthUser {
  id: number
  email: string
  name: string
  timezone: string
  default_grouping: 'time' | 'project'
}
