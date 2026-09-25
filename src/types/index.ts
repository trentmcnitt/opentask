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

/**
 * A quota's prompt settings (quota reminders, 2026-09-24). Every field is
 * optional: an absent one takes the default, so NULL/{} is "the defaults".
 * Slot ids are `time_slots.id`s resolved at read time — a deleted slot falls
 * back rather than stranding the prompt.
 */
export interface QuotaPromptConfig {
  /** Default: on for daily/weekly/monthly quotas, off for yearly and period-less. */
  enabled?: boolean
  /** The period this quota prompts in; default the user's `quota_prompt_slot_id`. */
  slot_id?: number | null
  /** Daily quotas only: the period for prompt #k, keyed "1".."N". */
  numbers?: Record<string, number | null>
}

/** One local day of a quota's prompt activity (server-owned). */
export interface QuotaDayState {
  /** The owner's local date, YYYY-MM-DD. */
  date: string
  /** Net progress logged today from anywhere (never below 0). */
  logged: number
  /** prompt_keys "did it" today — the idempotency record. */
  did: string[]
  /** prompt_keys considered today (the circle, or "did it", which implies it). */
  considered: string[]
}

export interface Task {
  id: number
  user_id: number
  project_id: number
  title: string
  original_title: string | null
  /**
   * Short label for the quota widget chip (§5). Only meaningful on a tracked
   * task — the widget shows every quota as a small tappable chip, and a full
   * quota title ("Balloon breathing practice (teach Mia...)") doesn't fit.
   * Not rejected on an ordinary task, just unused there. Null unless set.
   */
  short_title: string | null
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
   * §5: the UTC instant the current period began, by the user's local calendar
   * (Monday 00:00 for a week, the 1st for a month). Written by the period
   * rollover job — see `src/core/tasks/period-rollover.ts` — and null until it
   * first runs for a quota. This is a quota's ONLY anchor in time: it has no
   * `due_at`, so anything computing how far through the period a quota is (the
   * iOS Track widget's pace tick) must read this, not a date.
   */
  progress_period_start: string | null

  /**
   * Quota reminders (2026-09-24): where and whether this quota prompts on the
   * Reminders surface. NULL = the defaults for its period. See
   * `src/core/tasks/quota-prompts.ts`.
   */
  quota_prompt_config: QuotaPromptConfig | null
  /**
   * What happened to this quota's prompts on the owner's local `date` —
   * server-owned, restored by undo. A stale date reads as an empty day.
   */
  quota_day_state: QuotaDayState | null

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
  // Editable time slots: a slot's start moved / a slot removed, with the
  // reminders that moved to stay in (or find) a slot. The entry also carries
  // the slot row (`undo_log.slot_state`) so undo restores both together.
  | 'time_slot_edit'
  | 'time_slot_delete'
  // Quota reminders (2026-09-24): prompts considered and/or "did it". A batch
  // mixed with reminder completions logs as 'bulk_done' instead.
  | 'quota_prompt'

/**
 * The one time_slots row a time_slot_edit / time_slot_delete entry changed,
 * before and after. `after: null` is a deletion. Stored in
 * `undo_log.slot_state`; undo writes `before` back, redo writes `after`.
 */
export interface SlotUndoState {
  before: SlotRow | null
  after: SlotRow | null
  /**
   * A time_slot_delete that repointed the user's default quota prompt period
   * (`users.quota_prompt_slot_id`) from the removed slot to the nearest one
   * (2026-09-25). Absent when the default did not name the removed slot, and
   * on every entry logged before this existed.
   */
  prompt_default?: { before: number | null; after: number | null }
}

/** A time_slots row as stored — mirrors `TimeSlot` in `@/lib/time-slot-assign`. */
export interface SlotRow {
  id: number
  user_id: number
  label: string
  start_time: string
  sort_order: number
  created_at: string
}

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
