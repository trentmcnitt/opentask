// Core domain types for OpenTask

import type { GroupingMode } from '@/lib/grouping'
import type { SettingChange } from '@/lib/anchor-times'

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
  /** What belongs in this project (2026-10-10), at most PROJECT_DESCRIPTION_MAX chars; null when unset. */
  description: string | null
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
  /**
   * What each key in `did` added to the count (2026-09-25) — so putting the
   * prompt back takes away exactly that. A daily #k did-it adds only what was
   * missing up to k, possibly 0, which nothing else records.
   */
  did_applied: Record<string, number>
}

/** What a repeating task's scheduled instant is (`Task.repeat_anchor`). */
export type RepeatAnchor = 'target' | 'deadline'

export interface Task {
  id: number
  user_id: number
  project_id: number
  title: string
  original_title: string | null
  /**
   * Short label for the quota widget chip (§5). Only meaningful on a tracked
   * task — the widget shows every quota as a small tappable chip, and a full
   * quota title ("Posture practice (tall spine, soft jaw...)") doesn't fit.
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
  /**
   * What the rule's instant (`occurrence_at`) IS (2026-10-21; read only when
   * `rrule` is set): 'target' — the occurrence is the target, no deadline;
   * 'deadline' — the occurrence is the deadline (`deadline_at` mirrors it) and
   * the target is derived from it, `target_days_before` local calendar days
   * earlier at `target_time` (HH:MM). Both are set iff the anchor is
   * 'deadline'. The dates of an occurrence: `occurrenceDates`.
   *
   * Null only in API responses, on a one-off (`formatTaskResponse`): the
   * column is never null, so a row read on the server carries what is stored
   * ('target' on a one-off) and every undo snapshot can be written back.
   */
  repeat_anchor: RepeatAnchor | null
  /**
   * RELATIVE TARGETS (2026-10-24, docs/TASK-MODEL.md § Relative targets): the
   * same pair on a ONE-OFF with a deadline makes its target relative — derived
   * from the deadline (`relativeTargetAt`) and moved with it; any picked date
   * makes it fixed again (both null). `isRelativeOneOff` is the test.
   */
  target_days_before: number | null
  target_time: string | null
  /**
   * The reminder period `target_time` follows (a link), or null for a custom
   * time (2026-10-24). When set, `target_time` is that period's current start
   * — a period retime rewrites both (src/core/time-slots/edit.ts). The OWNER's
   * period, on a shared task too.
   */
  target_slot_id: number | null
  /**
   * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends). The stored
   * `rrule` never carries COUNT or UNTIL; the end lives here and ONE pure
   * judge reads it (`repeatStep` in src/lib/task-segments.ts):
   *  - `repeat_count`: "After N times" — occurrences in the series (1..999);
   *  - `repeat_count_used`: occurrences closed (done or skipped) since the
   *    count was set — every done and skip of a repeating task adds one;
   *  - `repeat_until`: "On date" — the last LOCAL day (yyyy-MM-dd, the
   *    owner's zone), inclusive: an occurrence on or before it is in the series.
   * Count and date are exclusive. Only on an ordinary repeating task. When
   * the series ends the task is archived (done=1 for a done, done=0 for a skip).
   */
  repeat_count: number | null
  repeat_count_used: number
  repeat_until: string | null
  /**
   * Derived on read (`isLastOccurrence`), only on a row with an end: closing
   * the current occurrence ends the series. Absent on a row read without its
   * owner's zone; the API response always carries it (`formatTaskResponse`).
   */
  repeat_last?: boolean
  /** Derived on read: `repeat_count − repeat_count_used` (the current one included), else null. */
  repeat_remaining?: number | null

  // The FIRST-TARGET date (2026-10-10): kept by every move, set when a task
  // with no target gets one, cleared with the target, and reset to the next
  // occurrence by a completion advance. The target-age badge counts from it,
  // and old native builds read it (`TargetAge.swift`). Since 2026-10-12 (§6)
  // there is no snooze state: no snoozed flag, no snooze count.
  original_due_at: string | null
  /**
   * A repeating task's SCHEDULED occurrence (§6, 2026-10-12). `due_at` is its
   * target; a move (any snooze) changes only `due_at`. Done and skip advance
   * from this and set its dates (`occurrenceDates`). On a deadline-anchored
   * repeat (`repeat_anchor`) it IS the deadline. Null for a
   * one-off.
   */
  occurrence_at: string | null

  /**
   * Task model (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
   * `due_at` above is the TARGET — when nagging starts. `deadline_at` is the
   * real cutoff: a snooze never moves it, and it caps one.
   */
  deadline_at: string | null
  /** How soon it should get done. null = unset (treated as weeks). */
  horizon: 'days' | 'weeks' | 'months' | 'eventually' | null
  /** When `horizon` was last set or re-affirmed (Process's growth clock). */
  horizon_set_at: string | null
  /** "I saw it", from a task segment's circle. Never a completion. */
  last_considered_at: string | null
  /** A task segment's Defer All: hidden for that local day. Not a consider. */
  segment_deferred_at: string | null
  /**
   * When the task was last targeted FROM A TASK SEGMENT — the row's Today
   * button or its long-press time picker (`POST /api/task-segments/target-today`,
   * which Process's "Do it" shares). The dashboard's Just now card lists it
   * for 15 minutes (`src/lib/just-added.ts`). Deliberately NOT a general
   * "target changed" stamp: snooze, edit, create and a recurrence advance
   * never set it.
   */
  segment_targeted_at: string | null
  /**
   * When the target was last set by ANY path (2026-10-12) — create, a move,
   * Today, a completion advance, skip, enrichment, a deadline change. The
   * anchor of Upcoming's wait (`src/lib/task-segments.ts`); null reads as
   * created_at (`targetSetAtOf`). Distinct from `segment_targeted_at`.
   */
  target_set_at: string | null
  /**
   * `due_at` is the deadline's AUTOMATIC target (§8, 2026-10-12): stored by
   * the server whenever a one-off has a deadline and no target the user
   * picked (`autoTargetAt`). Only a picked target (false) makes a task quiet
   * until its date.
   */
  target_auto: boolean
  /**
   * ATTEMPTS (spec §7, 2026-10-12): local days on which the task was over
   * target, AS OF THE READ (`effectiveAttempts` in src/lib/task-segments.ts —
   * the server reads it in `rowToTask`). Reset by done and each new
   * occurrence; frozen while there is no target. The badge ("3×") shows only
   * while the task has a target.
   */
  attempts: number
  /** The local date (yyyy-MM-dd) `attempts` counts through. */
  attempts_counted_through: string | null
  /** Process's last "keep" of the horizon (ruling Q7); null = never kept. */
  growth_kept_at: string | null
  /**
   * THE TASK QUEUE (2026-10-19, docs/TASK-MODEL.md § Picks and defers).
   * `queue_mark`: a defer (Snooze-all, Try Tomorrow) landing at or after the
   * next rollover moved the target to that rollover and marked the task; the
   * rollover strips it into the queue. Any other target write clears it.
   * `try_tomorrow`: the same mark, set by Try Tomorrow. `queued_at`: when the
   * rollover queued it (cleared by any target write); `queued_from_due_at`:
   * the target it had then, kept.
   */
  queue_mark: boolean
  try_tomorrow: boolean
  queued_at: string | null
  queued_from_due_at: string | null
  /**
   * When the rollover (task-queue PR 2) last changed this task — a strip, a
   * repeating roll or a wait. The undo fence's witness: an undo entry written
   * before it skips this task. Null = never.
   */
  rolled_over_at: string | null
  /**
   * ON DECK (2026-10-20, docs/TASK-MODEL.md § On deck): the owner's local
   * CALENDAR date (yyyy-MM-dd) the task is on deck for — a day with no nag.
   * Never together with a picked target (rule 1). Null = not on deck.
   * `queued_from_deck_day`: the deck day the rollover remembered when it sent
   * the undone deck to the queue (shown in details only, never on the row).
   */
  on_deck_day: string | null
  queued_from_deck_day: string | null
  /**
   * THE DEADLINES PAGE (2026-10-22, docs/TASK-MODEL.md § The deadlines page).
   * `lead_from`: the local OpenTask day (yyyy-MM-dd) a deadline task with no
   * target goes on the deadlines page — this instance's; derived on every
   * deadline write and advance (`leadFor`), moved by Defer
   * (`POST /api/task-segments/defer-lead`). Set on an ordinary task with a
   * deadline and no relative target, dormant while it has a target; else
   * null. `lead_days`: the user's override of the lead (local days before the
   * deadline's day), series-level on a repeat; null = the default table.
   */
  lead_days: number | null
  lead_from: string | null

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
   * (00:00 on the user's first day of the week — `users.week_start`, Sunday
   * by default — for a week, the 1st for a month). Written by the period
   * rollover job — see `src/core/tasks/period-rollover.ts` — and null until it
   * first runs for a quota. This is a quota's ONLY anchor in time: it has no
   * `due_at`, so anything computing how far through the period a quota is (the
   * iOS Track widget's pace tick) must read this, not a date.
   */
  progress_period_start: string | null
  /**
   * Interval quotas (2026-10-16): the current period, SERVED — computed on
   * every read (`rowToTask`, `quotaPeriodFields` in `@/lib/track`) in the
   * owner's clock, so no client repeats `quotaPeriodEnd`. `progress_period_end`
   * is the window's exclusive end (UTC), `period_interval` the rule's INTERVAL,
   * `period_last_day` the window's last local day (`YYYY-MM-DD`), and
   * `period_label` "by Oct 24" for an interval above 1 — null at interval 1,
   * where clients keep their own words ("this week"). All null on a non-quota.
   * Optional: a Task built by hand (tests, an optimistic row) has none.
   */
  progress_period_end?: string | null
  period_interval?: number | null
  period_last_day?: string | null
  period_label?: string | null

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
  /** Which client made it (`src/lib/client-attribution.ts`); null on rows before 2026-10-20. */
  client: string | null
  /** The Bearer token's name, or null (session, proxy, system, older rows). */
  token_name: string | null
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
  // Skip until (task queue PR 4): one entry for a batch of repeating tasks
  // skipped past this occurrence or to a date — each task's skip snapshot.
  | 'bulk_skip'
  // Editable time slots: a slot's start moved / a slot removed, with the
  // reminders that moved to stay in (or find) a slot. The entry also carries
  // the slot row (`undo_log.slot_state`) so undo restores both together.
  | 'time_slot_edit'
  | 'time_slot_delete'
  // Quota reminders (2026-09-24): prompts considered and/or "did it". A batch
  // mixed with reminder completions logs as 'bulk_done' instead.
  | 'quota_prompt'
  // Task model (2026-10-10): a task segment's circle (considered) or Defer All.
  // Field snapshots of last_considered_at / segment_deferred_at; never a completion.
  | 'task_segment'
  // The task queue (2026-10-20): "Roll over now" — the rollover run by hand
  // (src/core/tasks/rollover-now.ts). The cron's rollover writes no entry.
  | 'task_rollover'
  // On deck (2026-10-20): POST /api/tasks/deck — decked or un-decked
  // (src/core/tasks/deck.ts). Field snapshots, like a bulk edit.
  | 'deck'

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
  /**
   * A time_slot_delete that converted the user's settings linked to the
   * removed period — Morning, Wake, Sleep, number-pad buttons — to custom
   * times at its start (anchor times, 2026-10-21). Undo puts the links back,
   * redo converts again, each compare-and-set (`settingWrites`). Absent when
   * nothing linked to the period, and on every entry logged before this existed.
   */
  user_settings?: SettingChange[]
  /**
   * RELATIVE TARGETS (2026-10-24): a time_slot_edit's retime of the CLOSED
   * (done, archived or trashed) rows linked to the period — one
   * compare-and-set statement, `target_time` from `before` to `after`
   * (`due_at` untouched: a reopen re-derives it). Undo and redo apply the
   * mirror statement (`applyTargetRows`). Open rows ride the snapshots.
   */
  target_times?: { slot_id: number; before: string; after: string }
  /**
   * A time_slot_delete's closed rows whose link it removed (their time kept);
   * undo re-links, compare-and-set — only rows still unlinked at the period's
   * start. Open rows ride the snapshots.
   */
  target_unlinked?: number[]
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
  | 'FEATURE_SHELVED'
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
   * The dashboard view — `'project'` (Now), `'new'` (Newest) or `'unified'`
   * (the AI-sort / "Unified" flat list). See `src/lib/grouping.ts`; the
   * retired `'slot'` and `'time'` are coerced to `'project'` by `toAuthUser`.
   *
   * Nothing reads this to make a decision: it is only ever echoed back out
   * (`/api/auth/me`, the NextAuth session, the iOS token-provision response).
   * The dashboard's live view preference comes from `PreferencesProvider`,
   * which fetches `/api/user/preferences` directly.
   */
  default_grouping: GroupingMode
  is_demo: boolean
}
