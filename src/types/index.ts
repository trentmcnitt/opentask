// Core domain types for OpenTask

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray'

export interface LabelConfig {
  name: string
  color: LabelColor
}

export interface PriorityDisplayConfig {
  trailingDot: boolean // Show priority indicator on the indicators line
  badgeStyle: 'words' | 'icons' // 'words' = "Low"/"Medium"/"High"/"Urgent", 'icons' = ●/●/!/!!
  colorTitle: boolean // Color task title based on priority
  rightBorder: boolean // Show colored right border
  colorCheckbox: boolean // Color the done-button circle border based on priority
}

export interface Project {
  id: number
  name: string
  owner_id: number
  shared: boolean
  sort_order: number
  color: LabelColor | null
  active_count: number
  overdue_count: number
  created_at: string
}

export interface Task {
  id: number
  user_id: number
  project_id: number
  title: string
  original_title: string | null
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
  last_critical_alert_at: string | null
  auto_snooze_minutes: number | null

  // Soft delete and archive
  deleted_at: string | null
  archived_at: string | null

  // Labels
  labels: string[]

  // Track / quotas (§5). A tracked task counts occurrences toward a target per
  // period; at target it is "met" but stays open until the period boundary, so
  // overflow (3/2) stays observable. progress_target > 1 implies tracked;
  // is_tracked marks a quota whose target is 1 ("date night, once a month").
  progress_target: number
  progress_current: number
  is_tracked: boolean

  /**
   * §6: this item lives on the Reminders surface — a prompted thought rather
   * than an action. Reminders have NO DEBT: they never count as overdue, never
   * reach the badge, never fire individually, and can't be snoozed out of their
   * time slot. Completion means "considered", which IS its completion.
   * Mutually exclusive with Track (progress_target > 1).
   */
  is_reminder: boolean

  // Per-task stats (survive beyond completions retention)
  completion_count: number
  snooze_count: number
  /** §7.5: occurrences declined without a completion, so completion_count stays honest. */
  skip_count: number
  first_completed_at: string | null
  last_completed_at: string | null
  notes: string | null

  created_at: string
  updated_at: string
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
  // §5: a +1 on a tracked task is its own action, distinct from 'done' —
  // undoing an increment must not look like undoing a completion.
  | 'progress'
  // §7.5: declining an occurrence without recording a completion.
  | 'skip'
  | 'bulk_skip'

export interface UndoSnapshot {
  task_id: number
  before_state: Partial<Task>
  after_state: Partial<Task>
  completion_id?: number // Tracks the completion record to delete on undo
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
  /**
   * §7.3 adds 'slot' — today grouped by time slot, the new front door.
   *
   * Nothing reads this to make a decision: it is only ever echoed back out
   * (`/api/auth/me`, the NextAuth session, the iOS token-provision response).
   * The dashboard's live view preference comes from `PreferencesProvider`,
   * which fetches `/api/user/preferences` directly.
   */
  default_grouping: 'time' | 'project' | 'unified' | 'slot'
  is_demo: boolean
}
