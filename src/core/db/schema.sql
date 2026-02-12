-- OpenTask Database Schema
-- SQLite with WAL mode for optimal concurrent read/write performance

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'America/Chicago',
  ntfy_topic    TEXT,
  ntfy_server   TEXT,
  default_grouping TEXT NOT NULL DEFAULT 'project',
  label_config  TEXT NOT NULL DEFAULT '[]',
  priority_display TEXT NOT NULL DEFAULT '{"trailingDot":true,"colorTitle":false,"rightBorder":false}',
  auto_snooze_minutes INTEGER NOT NULL DEFAULT 30,
  default_snooze_option TEXT NOT NULL DEFAULT '60',
  morning_time  TEXT NOT NULL DEFAULT '09:00',
  ai_context    TEXT,
  ai_mode       TEXT NOT NULL DEFAULT 'bubble',
  ai_show_scores INTEGER NOT NULL DEFAULT 1,
  ai_show_signals INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  shared     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
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
  last_notified_at TEXT,
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

-- API tokens table
CREATE TABLE IF NOT EXISTS api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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

CREATE INDEX IF NOT EXISTS idx_undo_log_user_id ON undo_log(user_id);
CREATE INDEX IF NOT EXISTS idx_undo_log_undone ON undo_log(user_id, undone);

CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);

CREATE INDEX IF NOT EXISTS idx_user_daily_stats_user_date
  ON user_daily_stats(user_id, date);
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
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_activity_log_user_id ON ai_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_activity_log_task_id ON ai_activity_log(task_id);

-- AI review results (cached per-task scores, commentary, and signals from AI review)
CREATE TABLE IF NOT EXISTS ai_review_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  task_id      INTEGER NOT NULL REFERENCES tasks(id),
  score        INTEGER NOT NULL,
  commentary   TEXT NOT NULL,
  signals      TEXT,
  generated_at TEXT NOT NULL,
  UNIQUE(user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_review_results_user
  ON ai_review_results(user_id);

-- AI review sessions (tracks generation progress for polling)
CREATE TABLE IF NOT EXISTS ai_review_sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'running',
  total_tasks  INTEGER NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
);

