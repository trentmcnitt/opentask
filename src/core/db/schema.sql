-- OpenTask Database Schema
-- SQLite with WAL mode for optimal concurrent read/write performance

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  ntfy_topic    TEXT,            -- Vestigial (ntfy removed); kept for existing DB compat
  ntfy_server   TEXT,           -- Vestigial (ntfy removed); kept for existing DB compat
  pushover_user_key TEXT,       -- Vestigial (Pushover removed); kept for existing DB compat
  pushover_sound TEXT NOT NULL DEFAULT 'echo', -- Vestigial (Pushover removed); kept for existing DB compat
  default_grouping TEXT NOT NULL DEFAULT 'project', -- Now (by project); 'slot' and 'time' are retired and read as 'project', see src/lib/grouping.ts
  -- 'horizon' (effective horizon → deadline → priority → recency) is the
  -- default since 2026-10-11 (Trent); a saved sort is never changed.
  default_sort TEXT NOT NULL DEFAULT 'horizon',
  default_sort_reversed INTEGER NOT NULL DEFAULT 0,
  -- §7.3: dashboard filter-chip section starts collapsed; this remembers the
  -- user's explicit choice to keep it open.
  filters_expanded INTEGER NOT NULL DEFAULT 0,
  -- Now with its folds lifted (Show all): how many tasks each project group shows before "Show all"
  -- (1-50, validated by the preferences route).
  project_preview_count INTEGER NOT NULL DEFAULT 6,
  -- §5: the Track panel on the Tasks page starts folded to one line; this
  -- remembers the user's explicit choice to keep it open.
  track_expanded INTEGER NOT NULL DEFAULT 0,
  -- §5: /quotas opened on its Details list instead of the summary. Unread
  -- since 2026-10-16 (the Details list is gone); kept for the preferences API.
  quotas_details INTEGER NOT NULL DEFAULT 0,
  label_config  TEXT NOT NULL DEFAULT '[]',
  priority_display TEXT NOT NULL DEFAULT '{"trailingDot":true,"badgeStyle":"words","colorTitle":false,"rightBorder":false,"colorCheckbox":true}',
  auto_snooze_minutes INTEGER NOT NULL DEFAULT 30,
  auto_snooze_urgent_minutes INTEGER NOT NULL DEFAULT 5,
  auto_snooze_high_minutes INTEGER NOT NULL DEFAULT 15,
  -- §4.1: the cadence ladder. auto_snooze_minutes above is now P0-ONLY.
  -- P1 is rare-but-present rather than silent, and P2 is NOT notify-once:
  -- one missed glance (phone face-down, in a meeting) would lose it
  -- permanently, which fails dangerous for something rated moderately
  -- important. Nothing goes fully silent by default (L2) — the bottom rungs
  -- get slower cadence plus replacement (§4.2), so persistence never becomes
  -- pile-up.
  auto_snooze_low_minutes INTEGER NOT NULL DEFAULT 240,
  auto_snooze_medium_minutes INTEGER NOT NULL DEFAULT 60,
  default_snooze_option TEXT NOT NULL DEFAULT '60',
  bulk_snooze_default TEXT NOT NULL DEFAULT 'next_period',
  -- First day of the user's week: 'sunday' (default) or 'monday'. Sets where a
  -- weekly quota's period begins and ends (src/lib/week-start.ts).
  week_start TEXT NOT NULL DEFAULT 'sunday',
  -- The weekday the horizon segments come round on (2026-10-12): Luxon
  -- numbering, 1 = Monday … 7 = Sunday; default 6 = Saturday. Weeks shows on
  -- it, Months on the first one of the month, Eventually on the first one of
  -- Jan/Apr/Jul/Oct (src/lib/task-segments.ts). Independent of week_start, and
  -- no part of Upcoming.
  check_in_day INTEGER NOT NULL DEFAULT 6,
  morning_time  TEXT NOT NULL DEFAULT '09:00',
  -- The task queue (2026-10-19, docs/TASK-MODEL.md § The OpenTask day): the
  -- OpenTask day (yyyy-MM-dd) whose rollover last ran for this user, so it
  -- runs exactly once. Written by the rollover job (task-queue PR 2), never
  -- by PR 1. PR 2's migration stamps it `WHERE last_rollover_date IS NULL`
  -- with each user's CURRENT OpenTask day, so NULL must never be read as
  -- "never ran, strip everything".
  last_rollover_date TEXT DEFAULT NULL,
  wake_time     TEXT NOT NULL DEFAULT '07:00',
  sleep_time    TEXT NOT NULL DEFAULT '22:00',
  -- Anchor times (2026-10-21, src/lib/anchor-times.ts): Morning, Wake and
  -- Sleep each either a custom time (slot id NULL) or linked to a reminder
  -- period (a time_slots id, no foreign key — like quota_prompt_slot_id), in
  -- which case they follow its start and *_time holds the start as of the
  -- link. pad_presets: the number pad's four buttons, a JSON array of 4
  -- {"time":"HH:MM","slot_id":id|null}; NULL = 09:00, 12:00, 16:00, 20:30.
  morning_slot_id INTEGER DEFAULT NULL,
  wake_slot_id    INTEGER DEFAULT NULL,
  sleep_slot_id   INTEGER DEFAULT NULL,
  pad_presets     TEXT DEFAULT NULL,
  -- "Day starts at" (2026-10-23, src/lib/anchor-times.ts): when the OpenTask
  -- day turns. Both NULL (the default) = 03:00 for everyone
  -- (DEFAULT_DAY_START, 2026-10-24; read, never written). A custom time: slot id
  -- NULL. Linked: the period's id, and day_start_time its start as of the
  -- link (a snapshot, like the anchor times').
  day_start_time    TEXT DEFAULT NULL,
  day_start_slot_id INTEGER DEFAULT NULL,
  ai_context    TEXT,
  -- When ai_context last changed (2026-10-10): the staleness warning reads it.
  ai_context_updated_at TEXT,
  ai_mode       TEXT NOT NULL DEFAULT 'on',
  ai_show_scores INTEGER NOT NULL DEFAULT 1,
  ai_show_signals INTEGER NOT NULL DEFAULT 1,
  ai_show_whats_next INTEGER NOT NULL DEFAULT 1,
  ai_show_insights INTEGER NOT NULL DEFAULT 1,
  ai_show_commentary INTEGER NOT NULL DEFAULT 1,
  ai_whats_next_model TEXT NOT NULL DEFAULT 'haiku',
  ai_wn_commentary_unfiltered INTEGER NOT NULL DEFAULT 0,
  ai_wn_highlight INTEGER NOT NULL DEFAULT 1,
  ai_insights_signal_chips INTEGER NOT NULL DEFAULT 1,
  ai_insights_score_chips INTEGER NOT NULL DEFAULT 1,
  ai_quick_take INTEGER NOT NULL DEFAULT 0,    -- vestigial (unused; kept, not dropped)
  ai_provider   TEXT NOT NULL DEFAULT 'default', -- vestigial (read only by the per-feature mode backfill in runMigrations)
  ai_enrichment_mode  TEXT NOT NULL DEFAULT 'api',
  ai_quicktake_mode   TEXT NOT NULL DEFAULT 'api',
  ai_whats_next_mode  TEXT NOT NULL DEFAULT 'api',
  ai_insights_mode    TEXT NOT NULL DEFAULT 'api',
  -- Process's AI (project recommendations, duplicate groups) — its own mode
  -- since 2026-10-22; existing databases backfill it from ai_insights_mode.
  ai_process_mode     TEXT NOT NULL DEFAULT 'api',
  ai_query_timeout_ms INTEGER,              -- vestigial (replaced by per-feature timeouts below)
  ai_enrichment_timeout_ms INTEGER,
  ai_quicktake_timeout_ms INTEGER,
  ai_whats_next_timeout_ms INTEGER,
  ai_insights_timeout_ms INTEGER,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  critical_alert_volume REAL NOT NULL DEFAULT 1.0,
  -- Quota reminders (2026-09-24). The period unmet quotas prompt in by
  -- default (a time_slots id; NULL or a deleted slot = the first period of
  -- the day), and the user's own off switch for the whole feature.
  quota_prompt_slot_id INTEGER DEFAULT NULL,
  quota_prompts_enabled INTEGER NOT NULL DEFAULT 1,
  -- The quiet "AI finished" push for a just-added task
  -- (src/core/notifications/enrichment-notify.ts). On by default.
  enrichment_notifications_enabled INTEGER NOT NULL DEFAULT 1,
  -- The quiet push after a bulk snooze from outside the app that left High or
  -- Urgent tasks overdue (src/core/notifications/sweep-feedback.ts). On by default.
  sweep_feedback_notifications_enabled INTEGER NOT NULL DEFAULT 1,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  shared     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color      TEXT,
  -- What belongs in this project (2026-10-10), so the AI and desks choose a
  -- project correctly. Capped at PROJECT_DESCRIPTION_MAX in validation.
  description TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  original_title TEXT,
  -- Short label for the quota widget chip (§5). Only meaningful on a tracked
  -- task, but not rejected on an ordinary one. The web editor no longer offers
  -- it (widgets wrap long titles to two lines instead); the column and the API
  -- field stay for compatibility, and native widgets fall back to `title`.
  short_title   TEXT DEFAULT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  done_at       TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,
  due_at        TEXT,

  -- Recurrence (first-class, not bolted on)
  rrule         TEXT,
  recurrence_mode TEXT DEFAULT 'from_due',
  anchor_time   TEXT,
  anchor_dow    INTEGER,
  anchor_dom    INTEGER,
  -- What the rule's instant (`occurrence_at`) IS (2026-10-21, deadline-anchored
  -- repeats; docs/TASK-MODEL.md § Recurrence Model). Read only when rrule is set.
  --  'target'   — the occurrence is the target; no deadline (every repeat before).
  --  'deadline' — the occurrence is the DEADLINE (deadline_at mirrors it), and
  --               the target is derived from it: `target_days_before` local
  --               calendar days earlier (0 = the same day) at `target_time`
  --               (HH:MM, local). Both are set iff the anchor is 'deadline'.
  -- One pure function derives the dates of an occurrence (`occurrenceDates`
  -- in src/lib/task-segments.ts). Never on a reminder or a quota.
  --
  -- RELATIVE TARGETS (2026-10-24, docs/TASK-MODEL.md § Relative targets): a
  -- ONE-OFF with a deadline may carry the same pair — its target is then
  -- derived from its deadline (`relativeTargetAt`, the one derivation both
  -- shapes share) and moves with it. On a one-off both are set or neither;
  -- any picked date makes the target fixed again (both NULL).
  --  target_slot_id  the reminder period the target's TIME follows (a link,
  --                  no foreign key — the `quota_prompt_slot_id` precedent),
  --                  or NULL for a custom time. Invariant: when set,
  --                  `target_time` equals that period's current `start_time`
  --                  (the period retime rewrites both, src/core/time-slots/edit.ts).
  repeat_anchor TEXT NOT NULL DEFAULT 'target' CHECK (repeat_anchor IN ('target', 'deadline')),
  target_days_before INTEGER DEFAULT NULL,
  target_time   TEXT DEFAULT NULL,
  target_slot_id INTEGER DEFAULT NULL,
  -- REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends). The stored
  -- rrule never carries COUNT or UNTIL: the end lives here, read by ONE pure
  -- judge (`repeatStep` in src/lib/task-segments.ts).
  --  repeat_count      "After N times": occurrences in the series, 1..999.
  --  repeat_count_used occurrences closed (done OR skipped) since the count was set.
  --  repeat_until      "On date": the last LOCAL day (yyyy-MM-dd, owner's zone), inclusive.
  -- The count and the date are exclusive. Only on an ordinary repeating task.
  repeat_count      INTEGER DEFAULT NULL,
  repeat_count_used INTEGER NOT NULL DEFAULT 0,
  repeat_until      TEXT DEFAULT NULL,

  -- Snooze tracking (stores the original due_at when task is first snoozed)
  original_due_at  TEXT,

  -- Soft delete and archive
  deleted_at    TEXT,
  archived_at   TEXT,

  -- Labels (JSON array of strings)
  labels        TEXT NOT NULL DEFAULT '[]',
  -- Track / quotas (REDESIGN-V03 §5). Every task is already a quota with
  -- target 1; these generalise completion. progress_target > 1 marks a tracked
  -- task, which is exempt from the §4.1 notification cadence.
  progress_target  INTEGER NOT NULL DEFAULT 1,
  progress_current INTEGER NOT NULL DEFAULT 0,
  -- §7.5: occurrences declined without recording a completion, so
  -- completion_count stays honest.
  skip_count       INTEGER NOT NULL DEFAULT 0,
  -- Reminders surface (REDESIGN-V03 §6). A boolean column, deliberately NOT a
  -- label: §7.1 rules that kind is never stored as a name, and a
  -- behavior-bearing value inside the JSON labels array would need json_each()
  -- at every query site that wants an indexed boolean (overdue-checker,
  -- dashboard, badge).
  is_reminder      INTEGER NOT NULL DEFAULT 0,
  -- §5: an explicit "this is a quota" mark, for targets of 1 ("date night,
  -- once a month"). progress_target > 1 still implies it; this lets a count of
  -- one per period be tracked rather than scheduled.
  is_tracked       INTEGER NOT NULL DEFAULT 0,
  -- §5: when the quota's current period began (UTC ISO of the local period
  -- start). NULL until the rollover job first sees the task. The rollover
  -- advances it by the rrule's period and resets progress_current.
  progress_period_start TEXT,
  -- Quota reminders (2026-09-24): an unmet quota also appears as a "prompt"
  -- in a reminder period each day (src/core/tasks/quota-prompts.ts).
  -- quota_prompt_config: JSON {enabled?, slot_id?, numbers?: {"1": slotId}},
  -- NULL = the defaults for the quota's period (on, the user's default slot).
  -- Slot ids are resolved at read time, with fallbacks, so a deleted slot
  -- never strands a prompt.
  quota_prompt_config TEXT DEFAULT NULL,
  -- quota_day_state: JSON {date, logged, did: [key], considered: [key]} for the
  -- owner's LOCAL date. Server-owned; written in the same transaction as the
  -- progress or prompt action and restored by undo like any other field. A
  -- date other than today reads as empty.
  quota_day_state TEXT DEFAULT NULL,

  -- Task model (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon).
  -- `due_at` is the TARGET: when nagging starts, soft, snoozable.
  -- `deadline_at` is the real cutoff: never moved by a snooze, and it caps one.
  deadline_at   TEXT DEFAULT NULL,
  -- How soon the task should get done: 'days' | 'weeks' | 'months' |
  -- 'eventually'. NULL = unset, treated as weeks but never reported as set.
  -- Decides which task segment on the reminders screen it appears in.
  horizon       TEXT DEFAULT NULL,
  -- When `horizon` was last set or re-affirmed — the clock Process reads to ask
  -- whether a horizon should grow. NULL reads as created_at.
  horizon_set_at TEXT DEFAULT NULL,
  -- "I saw it" from a task segment's circle. Never a completion.
  last_considered_at TEXT DEFAULT NULL,
  -- A task segment's "Defer All": hidden for the rest of that local day,
  -- back tomorrow. Not a consider.
  segment_deferred_at TEXT DEFAULT NULL,
  -- When the task was last targeted FROM A TASK SEGMENT: the segment row's
  -- Today button or its long-press time picker (POST
  -- /api/task-segments/target-today, which Process's "Do it" also calls).
  -- Feeds the dashboard's Just now card for 15 minutes (src/lib/just-added.ts).
  -- Deliberately NOT a general "target changed" stamp: snooze, edit, create
  -- and a recurrence advance never set it. Undo restores the previous value.
  segment_targeted_at TEXT DEFAULT NULL,
  -- When the task's target was last SET by any path (2026-10-12): create, a
  -- move, Today, a completion advance, skip, enrichment, and any deadline
  -- change (it moves the effective target). The anchor for Upcoming's wait
  -- (src/lib/task-segments.ts). Stamped only through src/core/tasks/target-set.ts;
  -- undo restores it. NULL reads as created_at (a repeating task:
  -- max(created_at, last_completed_at)). Distinct from segment_targeted_at.
  target_set_at TEXT DEFAULT NULL,
  -- RETIRED 2026-10-12 (§8): the deadline's target is now stored
  -- (target_auto), so nothing reads or writes this. Kept so old undo entries
  -- that name it still apply; the API reports it as false for old native builds.
  deadline_nag_off INTEGER NOT NULL DEFAULT 0,
  -- 1 when due_at is the deadline's AUTOMATIC target (§8, 2026-10-12): stored,
  -- set by the server whenever a one-off has a deadline and no target the user
  -- picked (src/lib/task-segments.ts autoTargetAt). Only a picked target (0)
  -- makes a task quiet until its date.
  target_auto INTEGER NOT NULL DEFAULT 0,
  -- A repeating task's SCHEDULED occurrence (§6, 2026-10-12); due_at is its
  -- target, which a move changes alone. Done and skip advance from this and
  -- set its dates (occurrenceDates); a deadline-anchored repeat's IS its
  -- deadline (repeat_anchor). NULL for one-offs.
  occurrence_at TEXT DEFAULT NULL,
  -- ATTEMPTS (spec §7, 2026-10-12): local days on which the task was over
  -- target. `attempts` is the count as of the checkpoint
  -- `attempts_counted_through` (a local date, yyyy-MM-dd); the days since are
  -- added on read (effectiveAttempts in src/lib/task-segments.ts), persisted by
  -- the minute cron and by every write that moves the target. Reset by done
  -- and by each new occurrence; frozen while there is no target.
  attempts INTEGER NOT NULL DEFAULT 0,
  attempts_counted_through TEXT DEFAULT NULL,
  -- Process's last "keep" of this horizon (ruling Q7): the growth ask returns
  -- only one threshold period after it. NULL = never kept.
  growth_kept_at TEXT DEFAULT NULL,
  -- THE TASK QUEUE (2026-10-19, docs/TASK-MODEL.md § Picks and defers).
  -- queue_mark: a Snooze-all (a DEFER) that landed at or after the next
  -- rollover moved the target to that rollover moment and marked the task for
  -- the queue; the rollover (PR 2) strips it. Any other target write clears it
  -- (src/core/tasks/target-set.ts). try_tomorrow: the same, from the per-task
  -- Try Tomorrow, so tomorrow's queue row can be told apart.
  queue_mark INTEGER NOT NULL DEFAULT 0,
  try_tomorrow INTEGER NOT NULL DEFAULT 0,
  -- When the rollover put the task in the queue (PR 2; cleared by any target
  -- write), and the target it had then (kept, for a restore).
  queued_at TEXT DEFAULT NULL,
  queued_from_due_at TEXT DEFAULT NULL,
  -- The last SYSTEM change this task's older undo entries must not cross: the
  -- rollover (task-queue PR 2: a strip, a repeating roll or wait) and the
  -- deadline-anchor migration (2026-10-21, src/core/db/migrate-repeat-anchor.ts).
  -- The UNDO FENCE's witness: undo and redo skip a snapshot of this task from
  -- an entry written before it (src/core/undo/rollover-fence.ts). No target
  -- write clears it.
  rolled_over_at TEXT DEFAULT NULL,
  -- ON DECK (2026-10-20, docs/TASK-MODEL.md § On deck): the owner's local
  -- CALENDAR date (yyyy-MM-dd) the task is on deck for — "I'd like to get to
  -- this that day", a day with no nag. Never together with a picked target
  -- (src/core/tasks/deck-clear.ts). queued_from_deck_day: the deck day the
  -- rollover remembered when it sent an undone deck to the queue.
  on_deck_day TEXT DEFAULT NULL,
  queued_from_deck_day TEXT DEFAULT NULL,
  -- THE DEADLINES PAGE (2026-10-22, docs/TASK-MODEL.md § The deadlines page):
  -- lead_from = the owner's OpenTask day (yyyy-MM-dd) a deadline task with no
  -- target goes on the deadlines page (this instance's; derived on every
  -- deadline write and advance, moved by Defer — leadFor in
  -- src/lib/task-segments.ts). lead_days = the user's override of the lead
  -- (days before the deadline's day); NULL = the default table.
  lead_days INTEGER DEFAULT NULL,
  lead_from TEXT DEFAULT NULL,

  -- Notification tracking
  last_notified_at TEXT,            -- Vestigial (replaced by mod-based boundary detection); kept for existing DB compat
  last_critical_alert_at TEXT,      -- Vestigial (replaced by mod-based boundary detection); kept for existing DB compat
  auto_snooze_minutes INTEGER,

  -- Per-task stats (survive beyond completions retention)
  completion_count   INTEGER NOT NULL DEFAULT 0,
  -- RETIRED 2026-10-12 (§6: no snooze state): no longer written or returned.
  snooze_count       INTEGER NOT NULL DEFAULT 0,
  first_completed_at TEXT,
  last_completed_at  TEXT,
  notes              TEXT,

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Completions table (history for recurring tasks)
CREATE TABLE IF NOT EXISTS completions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  due_at_was  TEXT,
  due_at_next TEXT,
  -- The occurrence it completed (§6, 2026-10-12), so a put-back restores the
  -- schedule as well as the target. NULL on older rows: put-back reads due_at_was.
  occurrence_at_was TEXT,
  -- The occurrence it advanced TO (2026-10-21): put-back checks the task is
  -- still on it. NULL on older rows: put-back compares the target (due_at_next).
  occurrence_at_next TEXT,
  -- The task's attempts when it was completed (§7, 2026-10-12): how many local
  -- days the occurrence was over target. Put-back restores it.
  attempts INTEGER DEFAULT NULL
);

-- API tokens table (token column stores SHA-256 hash; token_preview stores last 8 chars of raw token)
CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token         TEXT NOT NULL UNIQUE,
  token_preview TEXT,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Last successful Bearer auth, written at most once a minute (bearer.ts).
  last_used_at  TEXT DEFAULT NULL
);

-- Undo log table
CREATE TABLE IF NOT EXISTS undo_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  action         TEXT NOT NULL,
  description    TEXT,
  fields_changed TEXT NOT NULL,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  undone         INTEGER NOT NULL DEFAULT 0,
  -- JSON { before, after } of ONE time_slots row, or NULL. Only the
  -- time_slot_edit / time_slot_delete actions set it: changing a slot's start
  -- or removing it moves that slot's reminders, and undo must put the slot
  -- back together with them (see src/core/time-slots/edit.ts).
  slot_state     TEXT DEFAULT NULL,
  -- Which client made the write ('web', 'ios', 'shortcut', 'system', ...) and,
  -- for a Bearer token, its name. NULL on rows from before 2026-10-20.
  -- See src/lib/client-attribution.ts.
  client         TEXT DEFAULT NULL,
  token_name     TEXT DEFAULT NULL
);

-- User daily stats table (aggregate stats with daily granularity)
CREATE TABLE IF NOT EXISTS user_daily_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  date          TEXT NOT NULL,  -- YYYY-MM-DD in user's timezone
  completions   INTEGER NOT NULL DEFAULT 0,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  snoozes       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_active ON tasks(user_id, done, deleted_at, archived_at);
-- Relative targets (2026-10-24): `idx_tasks_target_slot` is created in
-- runMigrations, AFTER its ALTER TABLE. Never index a column here that an
-- existing database only gets from runMigrations: this file runs first, so on
-- an upgrade the index would fail on "no such column" and the migration would
-- never run (prod, 10-24; guarded by DI-S01).

CREATE INDEX IF NOT EXISTS idx_completions_task_id ON completions(task_id);
CREATE INDEX IF NOT EXISTS idx_completions_user_id ON completions(user_id);
CREATE INDEX IF NOT EXISTS idx_completions_completed_at ON completions(completed_at);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);

-- idx_undo_log_user_id removed: redundant with idx_undo_log_undone (user_id is a prefix)
CREATE INDEX IF NOT EXISTS idx_undo_log_undone ON undo_log(user_id, undone);

CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);

-- idx_user_daily_stats_user_date removed: redundant with UNIQUE(user_id, date) constraint
CREATE INDEX IF NOT EXISTS idx_user_daily_stats_date
  ON user_daily_stats(date);

-- AI activity log (tracks all AI operations for debugging and cost visibility)
CREATE TABLE IF NOT EXISTS ai_activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  task_id     INTEGER,
  action      TEXT NOT NULL,
  status      TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  model       TEXT,
  duration_ms INTEGER,
  error       TEXT,
  provider    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_activity_log_user_id ON ai_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_activity_log_task_id ON ai_activity_log(task_id);

-- AI insights results (cached per-task scores, commentary, and signals from AI insights)
CREATE TABLE IF NOT EXISTS ai_insights_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  task_id      INTEGER NOT NULL REFERENCES tasks(id),
  score        INTEGER NOT NULL,
  commentary   TEXT NOT NULL,
  signals      TEXT,
  generated_at TEXT NOT NULL,
  UNIQUE(user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_results_user
  ON ai_insights_results(user_id);

-- Activity log (permanent mutation history for AI pattern analysis)
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  task_id     INTEGER NOT NULL,
  action      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'single',
  batch_id    TEXT,
  fields      TEXT,
  before      TEXT,
  after       TEXT,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Which client made the write, and the Bearer token's name (as undo_log).
  client      TEXT DEFAULT NULL,
  token_name  TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_log_user_created
  ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_task
  ON activity_log(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_action
  ON activity_log(user_id, action);
CREATE INDEX IF NOT EXISTS idx_activity_log_batch
  ON activity_log(batch_id);

-- Web Push subscriptions (browser push notification endpoints)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- APNs device tokens (iOS native app push notification endpoints)
CREATE TABLE IF NOT EXISTS apns_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  device_token TEXT NOT NULL UNIQUE,
  bundle_id    TEXT NOT NULL,
  environment  TEXT NOT NULL DEFAULT 'production',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_apns_devices_user_id ON apns_devices(user_id);

-- WidgetKit push tokens (iOS 26 / macOS 26 WidgetPushHandler — server-pushed
-- widget reloads, distinct from apns_devices above). A widget push token
-- belongs to the WIDGET EXTENSION process, not the app: it is registered by
-- `WidgetPushHandler.pushTokenDidChange` from inside the extension, and sent
-- with `apns-push-type: widgets` to the topic `<app bundle id>.push-type.widgets`
-- (computed from bundle_id at send time, not stored) rather than the app's
-- normal notification topic. See docs/NOTIFICATIONS.md.
--
-- widget_kind is informational (comma-joined kinds the token currently backs,
-- e.g. "OpenTaskReminders,OpenTaskTasks") — sends go to every token for a
-- user regardless of kind, since a WidgetKit push reloads all of that
-- extension's timelines, not one kind at a time.
CREATE TABLE IF NOT EXISTS widget_push_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  push_token   TEXT NOT NULL UNIQUE,
  bundle_id    TEXT NOT NULL,
  platform     TEXT NOT NULL,
  widget_kind  TEXT,
  environment  TEXT NOT NULL DEFAULT 'production',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_widget_push_tokens_user_id ON widget_push_tokens(user_id);

-- AI insights sessions (tracks generation progress for polling)
CREATE TABLE IF NOT EXISTS ai_insights_sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'running',
  total_tasks  INTEGER NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT,
  -- Last sign of life: set at start and after every chunk; staleness is judged from it
  heartbeat_at TEXT
);

-- Webhooks (HTTP callbacks on task events)
CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id  INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status_code INTEGER,
  error       TEXT,
  attempt     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);


-- Label registry (REDESIGN-V03 §7.2)
--
-- Labels used to be bare free-text inside tasks.labels, with no registry: a typo
-- silently forked the taxonomy into a new tag. Once labels can carry behavior
-- (ai-proposed / ai-added / ai-monitored are provenance, not decoration),
-- minting one by accident stops being cosmetic. Creation is therefore a discrete
-- act — see validateLabelsExist() in src/core/labels.
--
-- `facet` groups labels for the chip bar: AND across facets, OR within a facet.
CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  facet       TEXT NOT NULL DEFAULT 'domain',
  icon        TEXT,
  color       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_name ON labels(user_id, name);

-- Time slots (REDESIGN-V03 §6.0)
--
-- Life-moment containers ("Early morning", "Morning", "Evening") that both
-- the dashboard (§7.3) and the Reminders surface (§6) group by, so there is one
-- definition of "morning" rather than two that drift.
--
-- NAMING: this is a "time slot", never a "bucket". `bucket` already means the
-- due-date classifier in useFilterState.ts / DueDateFilterBar.tsx (overdue /
-- today / this-week), which is an unrelated concept.
--
-- Boundaries are seeded from the production clusters (07:00 / 09:00 / 12:00 /
-- 16:00 / 20:30) rather than invented — the slots emerge from how the corpus is
-- already scheduled. Labels and boundaries are user-editable.
CREATE TABLE IF NOT EXISTS time_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL,
  start_time  TEXT NOT NULL,   -- HH:MM local
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_time_slots_user ON time_slots(user_id, start_time);

-- Slot nags — RETIRED 2026-10-22: the slot nag paces through `nag_sends`
-- (key 'slot-nag') and nothing writes this table any more; the weekly purge
-- drains old rows, after which it can be dropped. Historical notes follow.
--
-- Notification plumbing, deliberately NOT in `user_daily_stats`: that table is
-- user-facing (completions, tasks created, snoozes) and a delivery counter is
-- not a statistic about the user.
--
-- One row per user per LOCAL day. `last_hour` is the local hour of the most
-- recent nag, which is what makes the claim idempotent: the minute sweep can
-- run twice in the same minute without consuming two of the day's three.
-- Rows are purged on the same weekly schedule as daily stats.
CREATE TABLE IF NOT EXISTS slot_nags (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  local_date TEXT NOT NULL,              -- YYYY-MM-DD in the user's timezone
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_hour  INTEGER NOT NULL,           -- local hour (0-23) of the most recent nag
  PRIMARY KEY (user_id, local_date)
);

-- When a nag was last sent, per user and source (nag-map fix #5, 2026-10-22).
-- A nag sends when now − last_sent_at ≥ its interval, in whole minutes, so a
-- restart, a double tick or downtime can neither repeat nor lose a send.
-- Keys: 'deadlines-page' (src/core/notifications/deadline-nags.ts), 'slot-nag'
-- (slot-nags.ts; the slot-open push stamps it too), 'reminder-<taskId>' (one per
-- Medium+ reminder, reminder-nags.ts; the weekly purge drops the rows of
-- reminders that are gone), and 'tick-<sender>' (the
-- minute each sender last sent in, tick.ts: a minute's pushes go out once).
-- See nag-sends.ts.
CREATE TABLE IF NOT EXISTS nag_sends (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  key          TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,              -- ISO 8601 UTC
  PRIMARY KEY (user_id, key)
);

-- Progress events (REDESIGN-V03 §5)
--
-- One row per +1 increment on a tracked task.
--
-- IMPORTANT: `logged_at` records WHEN THE USER LOGGED IT, not when they did it.
-- The user logs loosely, within roughly a day. That is fine for pace math
-- (which only needs counts within a period) but NOTHING may build timing
-- analysis on these timestamps — per L1, the looseness carries no signal.
CREATE TABLE IF NOT EXISTS progress_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL DEFAULT 1,
  logged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Where it was logged from (2026-10-16): web | widget | watch | mac | api,
  -- or undo | redo for the compensating row an undo/redo of a count writes,
  -- or unknown for a row logged before sources were recorded.
  -- See src/lib/progress-source.ts.
  source     TEXT NOT NULL DEFAULT 'api'
);
CREATE INDEX IF NOT EXISTS idx_progress_events_task ON progress_events(task_id, logged_at);

-- §5: one row per closed period of a quota — what was logged against the
-- target that week / month. Written by the rollover job at the period
-- boundary; a met period also writes a completions row.
CREATE TABLE IF NOT EXISTS progress_periods (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  logged       INTEGER NOT NULL,
  target       INTEGER NOT NULL,
  met          INTEGER NOT NULL DEFAULT 0,
  closed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- 1: a TRANSITION period ("Day starts at" PR 2, 2026-10-24) — its
  -- anchor's date was not its unit's first date (the old Monday-only week
  -- rule, a week-start change), so it ended early at the next unit's start
  -- (`anchorOnPeriodStart`). A day-start change never makes one: it moves
  -- the bounds, not the date. Unmet, it is neither met nor missed and does
  -- not break a streak (`getQuotaStats`).
  transition   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_progress_periods_task ON progress_periods(task_id, period_start);

-- Task segments' day roster (2026-10-22, src/core/tasks/segment-roster.ts):
-- every task a segment listed on a day, so the segment's "N of M" keeps M
-- fixed for the day — a row decked, targeted or done leaves the list but
-- still counts, as handled. Bookkeeping only: written by GET /api/reminders,
-- never in the undo log; rows older than yesterday are dropped on write.
-- `day` is the segment's day (yyyy-MM-dd): the OpenTask day for the queue's
-- panels, the calendar day for the rest.
CREATE TABLE IF NOT EXISTS segment_roster (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  kind     TEXT NOT NULL,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- How the row left, when the writer says so itself (2026-10-22): 'deferred'
  -- from the deadlines page's Defer (`deferLeads`). NULL = judged from the task.
  left_how TEXT DEFAULT NULL,
  -- Upcoming rows only (2026-10-25, the Upcoming split): the section the row
  -- was listed in, 'tomorrow' | 'later', kept current while it is listed. NULL
  -- on every other segment, and on a row remembered before the column (read
  -- as the section computed now). Added by runMigrations too: never index it
  -- here (DI-S01).
  section  TEXT DEFAULT NULL,
  PRIMARY KEY (user_id, day, kind, task_id)
);
