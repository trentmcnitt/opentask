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
  default_grouping TEXT NOT NULL DEFAULT 'project',
  default_sort TEXT NOT NULL DEFAULT 'due_date',
  default_sort_reversed INTEGER NOT NULL DEFAULT 0,
  label_config  TEXT NOT NULL DEFAULT '[]',
  priority_display TEXT NOT NULL DEFAULT '{"trailingDot":true,"badgeStyle":"words","colorTitle":false,"rightBorder":false,"colorCheckbox":true}',
  auto_snooze_minutes INTEGER NOT NULL DEFAULT 30,
  auto_snooze_urgent_minutes INTEGER NOT NULL DEFAULT 5,
  auto_snooze_high_minutes INTEGER NOT NULL DEFAULT 15,
  default_snooze_option TEXT NOT NULL DEFAULT '60',
  morning_time  TEXT NOT NULL DEFAULT '09:00',
  wake_time     TEXT NOT NULL DEFAULT '07:00',
  sleep_time    TEXT NOT NULL DEFAULT '22:00',
  ai_context    TEXT,
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
  ai_quick_take INTEGER NOT NULL DEFAULT 0,
  ai_provider   TEXT NOT NULL DEFAULT 'default',
  ai_enrichment_mode  TEXT NOT NULL DEFAULT 'api',
  ai_quicktake_mode   TEXT NOT NULL DEFAULT 'api',
  ai_whats_next_mode  TEXT NOT NULL DEFAULT 'api',
  ai_insights_mode    TEXT NOT NULL DEFAULT 'api',
  ai_query_timeout_ms INTEGER,              -- vestigial (replaced by per-feature timeouts below)
  ai_enrichment_timeout_ms INTEGER,
  ai_quicktake_timeout_ms INTEGER,
  ai_whats_next_timeout_ms INTEGER,
  ai_insights_timeout_ms INTEGER,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  critical_alert_volume REAL NOT NULL DEFAULT 1.0,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  original_title TEXT,
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

  -- Snooze tracking (stores the original due_at when task is first snoozed)
  original_due_at  TEXT,

  -- Soft delete and archive
  deleted_at    TEXT,
  archived_at   TEXT,

  -- Labels (JSON array of strings)
  labels        TEXT NOT NULL DEFAULT '[]',

  -- Notification tracking
  last_notified_at TEXT,            -- Vestigial (replaced by mod-based boundary detection); kept for existing DB compat
  last_critical_alert_at TEXT,      -- Vestigial (replaced by mod-based boundary detection); kept for existing DB compat
  auto_snooze_minutes INTEGER,

  -- Per-task stats (survive beyond completions retention)
  completion_count   INTEGER NOT NULL DEFAULT 0,
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
  due_at_next TEXT
);

-- API tokens table (token column stores SHA-256 hash; token_preview stores last 8 chars of raw token)
CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token         TEXT NOT NULL UNIQUE,
  token_preview TEXT,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
  undone         INTEGER NOT NULL DEFAULT 0
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
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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

-- AI insights sessions (tracks generation progress for polling)
CREATE TABLE IF NOT EXISTS ai_insights_sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'running',
  total_tasks  INTEGER NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
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

