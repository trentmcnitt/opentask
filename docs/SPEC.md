# OpenTask — Master Specification

_Version 0.2 — 2026-01-30_

**OpenTask** is a self-hosted, multi-user task management system designed for AI-assisted daily workflow management. It replaces a Vikunja-based system (also branded OpenTask) that was used from January 2026, carrying forward the behavioral specifications and workflow patterns that worked while eliminating the architectural workarounds that didn't.

**Logos:** `opentask-text-logo-abbr.png` (favicon/icon, "OT"), `opentask-text-logo.png` (full wordmark)

---

## Table of Contents

1. [Guiding Principles](#guiding-principles)
2. [Users and Roles](#users-and-roles)
3. [Architecture](#architecture)
4. [Data Model](#data-model)
5. [Recurrence System](#recurrence-system)
6. [Snooze System](#snooze-system)
7. [Undo / Redo](#undo--redo)
8. [Trash and Archive](#trash-and-archive)
9. [Projects and Organization](#projects-and-organization)
10. [Notifications](#notifications)
11. [Review Workflow (Claude Code)](#review-workflow-claude-code)
12. [API Design](#api-design)
13. [Web UI / PWA](#web-ui--pwa)
14. [CLI Tool](#cli-tool)
15. [Behavioral Specifications](#behavioral-specifications)
16. [Testing Strategy](#testing-strategy)
17. [Build Phases](#build-phases)
18. [Data Migration](#data-migration)
19. [Deployment](#deployment)
20. [Future Enhancements](#future-enhancements)

---

## Guiding Principles

### 1. AI Control Is the Primary Interface

The system is designed first for programmatic control by Claude Code, second for human interaction via web UI. Claude manages 50%+ of daily task operations (bulk done, snooze, review, triage). The API and CLI must be optimized for this use case.

### 2. Correct by Default

Recurring tasks must compute the correct next occurrence natively — no external webhook correction, no metadata workarounds, no defensive field preservation. The architecture must make the wrong thing hard and the right thing automatic.

### 3. Undo Everything

Every user action is reversible. Multi-step undo/redo with no practical limit. Users should feel safe making bulk changes because they can always go back. This is table stakes in 2026 — Excel, Word, VS Code, and the Due app all provide this.

### 4. Simple Feature Set

No comments, attachments, assignments, relationships, Gantt charts, sprints, milestones, or nested subtasks. Tasks have: title, notes, due date, recurrence, priority, project, labels. That's it.

### 5. Data Integrity Above All

This system manages client work and critical reminders. No operation should silently corrupt data. Partial updates (PATCH semantics), soft delete, and transactional batch operations are architectural requirements, not nice-to-haves.

---

## Users and Roles

### Initial Users

| User      | Role           | Usage Pattern                                                            |
| --------- | -------------- | ------------------------------------------------------------------------ |
| **Trent** | Primary user   | 150-200+ recurring tasks, 3 review sessions/day via Claude Code + web UI |
| **Kelly** | Secondary user | Separate task lists, shared family projects                              |

### Multi-User Requirements

- Each user has their own tasks, projects, and preferences
- Shared projects (e.g., "Family") are visible to all users
- Authentication via email/password (NextAuth/Auth.js) for web UI
- API token auth for CLI/programmatic access (per-user)
- No complex permissions model — see Shared Project Permissions below

### Shared Project Permissions

- Both users can create, edit, complete, snooze, and delete tasks in shared projects
- Tasks in shared projects are owned by their creator (`user_id` = creator)
- Either user can operate on any task in a shared project — no ownership restriction within shared projects
- Undo only reverses your own actions (User A cannot undo User B's mark-done)

### Auth Implementation

- **Web UI:** NextAuth/Auth.js with credentials provider (email/password), session cookies
- **CLI/API:** `Authorization: Bearer <token>` header. Tokens are stored in the `api_tokens` table (see Data Model)
- **Middleware:** Checks for either a valid session cookie OR a valid Bearer token on every API request
- **User seeding:** Initial users are created via `scripts/create-user.ts`. No self-registration for v1.

---

## Architecture

### Technology Stack

| Layer             | Technology                                    | Rationale                                                                                                        |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Runtime**       | Node.js / TypeScript                          | Single language for frontend + backend. Type safety. Trent's background.                                         |
| **Framework**     | Next.js (App Router)                          | Full-stack React framework. API routes + SSR + SPA. Mature, well-documented.                                     |
| **Database**      | SQLite + WAL mode                             | Single-file, zero-config, excellent single-server performance. Perfect for self-hosted single-digit user counts. |
| **DB Access**     | better-sqlite3                                | Direct SQLite access, synchronous API (ideal for Next.js API routes), battle-tested. No ORM for v1.              |
| **Recurrence**    | rrule.js                                      | RFC 5545 RRULE implementation. 12+ years mature.                                                                 |
| **UI Components** | ShadCN + Tailwind CSS                         | Component library Claude generates fluently. Accessible, customizable.                                           |
| **Auth**          | NextAuth / Auth.js                            | Session-based auth, credentials provider. Handles multi-user.                                                    |
| **PWA**           | next-pwa or manual service worker             | Installable on iOS/Android.                                                                                      |
| **Notifications** | Web Push (overdue alerts) + APNs (iOS native) | Browser-native push, no third-party relay. APNs for iOS with time-sensitive interruption.                        |

### System Diagram

```
                    ┌─────────────────────────────┐
                    │       Next.js Server         │
                    │                              │
  Web UI ──────────>│  app/api/*  (API routes)     │
  (Browser/PWA)     │       │                      │
                    │       ▼                      │
  CLI tool ────────>│  core/       (shared logic)  │
  (Claude Code)     │       │                      │
  (Bearer token)    │       ▼                      │
                    │  tasks.db    (SQLite + WAL)   │
                    │                              │
                    │  cron/       (notifications)  │
                    │  (node-cron in-process)       │
                    └─────────────────────────────┘
                              │
                              ▼
                    Web Push / APNs (external)
```

The CLI tool communicates via HTTP to the same API routes the web UI uses. Core business logic (recurrence computation, undo logging, validation) lives in a shared `core/` module imported by API routes. Notification polling runs in-process via `node-cron` (not a separate service).

### Timezone Handling (Decided)

- **Database:** Point-in-time datetimes (`due_at`, `created_at`, etc.) stored in UTC (ISO 8601 with `Z` suffix)
- **User preferences:** Each user has a `timezone` field (e.g., `America/Chicago`)
- **Display:** All times converted to user's local timezone on render (both API responses and web UI)
- **Input:** CLI and API accept local times; server converts to UTC using the authenticated user's timezone
- **RRULE and anchor fields: LOCAL TIME, not UTC.** `anchor_time` is "HH:MM" in the user's local timezone. `BYHOUR` in the RRULE is the local-time hour. This prevents DST drift — "8:00 AM Central" stays 8:00 AM year-round regardless of CST/CDT. rrule.js computes with timezone awareness via its `tzid` option (luxon plugin). DTSTART in the RRULE is also in local time with TZID.

**Why local time for recurrence:** A fixed UTC BYHOUR shifts by 1 hour at DST boundaries. "BYHOUR=14" means 8 AM CST but 9 AM CDT. Storing BYHOUR=8 with TZID=America/Chicago means "8 AM local" always.

### Deployment

Single server deployment. The Next.js app runs as a systemd service with SQLite stored on local disk. Reverse proxy via Caddy.

---

## Data Model

### Recurring Task Model (Decided: Advance in Place)

Recurring tasks are a **single row that advances in place.** When marked done:

1. `due_at` advances to the next occurrence (computed from RRULE)
2. `done` stays `0` (the task is immediately ready for the next occurrence)
3. A completion record is logged to `completions` table for history
4. The `undo_log` captures the before/after state for reversal

This matches the Vikunja behavior Trent is used to. There is no "old instance" to archive — the row persists forever, advancing each time.

**One-off tasks** behave differently: `done` is set to `1` and `archived_at` is set. They stay in the table but are hidden from active views.

### Tasks Table

```sql
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- short numeric IDs for CLI ergonomics
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  title         TEXT NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  done_at       TEXT,             -- ISO 8601 UTC, set when done=1 (one-offs only)
  priority      INTEGER NOT NULL DEFAULT 0,  -- 0=unset, 1=low, 2=medium, 3=high, 4=urgent
  due_at        TEXT,             -- ISO 8601 UTC datetime (nullable for no-due-date tasks)

  -- Recurrence (first-class, not bolted on)
  rrule         TEXT,             -- RFC 5545 RRULE string, NULL for one-off tasks
  recurrence_mode TEXT DEFAULT 'from_due',  -- 'from_due' or 'from_completion'
  anchor_time   TEXT,             -- HH:MM local time — the canonical time-of-day
  anchor_dow    INTEGER,          -- 0=Mon..6=Sun — canonical day-of-week (weekly/biweekly only)
  anchor_dom    INTEGER,          -- 1-31 — canonical day-of-month (monthly only)

  -- Snooze (first-class concept)
  original_due_at  TEXT,          -- original due_at before FIRST snooze, NULL if not snoozed
  snooze_count     INTEGER NOT NULL DEFAULT 0,  -- times task has been snoozed (lifetime stat)

  -- Soft delete and archive
  deleted_at    TEXT,             -- non-NULL = in trash (ISO 8601 UTC)
  archived_at   TEXT,             -- non-NULL = archived/completed one-off (ISO 8601 UTC)

  -- Labels
  labels        TEXT NOT NULL DEFAULT '[]',  -- JSON array of label strings

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

**Why INTEGER IDs:** The CLI is used by both Claude and Trent. `opentask done 42` is far more ergonomic than `opentask done a3f8b2c1d4e5`. Auto-increment integers are short, predictable, and human-friendly.

### Completions Table (History)

Tracks every time a recurring task is completed, for "what did I do today?" queries.

```sql
CREATE TABLE completions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  due_at_was  TEXT,   -- what due_at was before advancing (for audit)
  due_at_next TEXT    -- what due_at was set to after advancing (for audit)
);
```

### Notes Table

```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### Projects Table

```sql
CREATE TABLE projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  shared     INTEGER NOT NULL DEFAULT 0,  -- 1 = visible to all users
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### Users Table

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'America/Chicago',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### API Tokens Table

```sql
CREATE TABLE api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,  -- generated via crypto.randomBytes(32).toString('hex')
  name       TEXT NOT NULL,         -- e.g., "Claude Code", "CLI"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### Undo Log Table

```sql
CREATE TABLE undo_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  action         TEXT NOT NULL,     -- 'done', 'snooze', 'edit', 'delete', 'create', 'bulk_done', etc.
  description    TEXT,              -- Human-readable: "Marked 63 tasks done"
  fields_changed TEXT NOT NULL,     -- JSON array of field names this action modified
  snapshot       TEXT NOT NULL,     -- JSON: array of {task_id, before_state, after_state}
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  undone         INTEGER NOT NULL DEFAULT 0  -- 1 = this action has been undone
);
```

**Key addition: `fields_changed`.** This enables surgical undo — if the action changed `[done, due_at, original_due_at]`, undo only restores those fields, not the entire row. This prevents undo from clobbering edits made between the action and the undo.

### What This Eliminates vs. Vikunja

| Vikunja Workaround                        | OpenTask Equivalent                           |
| ----------------------------------------- | --------------------------------------------- |
| CANONICAL_TIME in description             | `anchor_time` column                          |
| CANONICAL_DOW in description              | `anchor_dow` column                           |
| CANONICAL_DOM in description              | `anchor_dom` column                           |
| Description `###` separator               | Notes table                                   |
| `safe_update_task()` field preservation   | PATCH semantics (only changed fields updated) |
| `repeat_after` in seconds                 | `rrule` string (RFC 5545)                     |
| `repeat_mode` magic integers              | `recurrence_mode` enum + RRULE                |
| No trash                                  | `deleted_at` soft delete                      |
| No archive                                | `archived_at` on one-off completion           |
| Webhook service for correction            | Inline computation at mark-done time          |
| Zero-date sentinel `0001-01-01T00:00:00Z` | NULL                                          |
| 32-char hex task IDs                      | Integer auto-increment IDs                    |
| No completion history                     | `completions` table                           |

---

## Recurrence System

### RRULE as Source of Truth

Every recurring task stores its schedule as an RFC 5545 RRULE string:

```
FREQ=DAILY;BYHOUR=9;BYMINUTE=0                     -- Daily at 9 AM
FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0    -- Mon/Wed/Fri at 9 AM
FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0      -- 1st of every month at 9 AM
FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=14;BYMINUTE=0       -- Last Friday of every month at 2 PM
FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=10           -- Every other Monday at 10 AM
```

### Anchor Fields — Derivation Rules

Anchor fields are **derived automatically** and serve as a display/sort cache:

| Source                    | anchor_time                | anchor_dow | anchor_dom |
| ------------------------- | -------------------------- | ---------- | ---------- |
| RRULE has BYHOUR/BYMINUTE | From RRULE                 | —          | —          |
| RRULE lacks BYHOUR        | From initial `due_at` time | —          | —          |
| RRULE has BYDAY (weekly)  | —                          | From RRULE | —          |
| RRULE has BYMONTHDAY      | —                          | —          | From RRULE |
| No RRULE (one-off)        | NULL                       | NULL       | NULL       |

**When RRULE is edited**, anchor fields are re-derived automatically. The server handles this — clients never set anchor fields directly.

### Recurrence Modes

| Mode                 | Behavior                                                             | Example                                                                        |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `from_due` (default) | Next occurrence computed from RRULE pattern anchored to the schedule | "Every Monday at 9 AM" → always Monday 9 AM regardless of when completed       |
| `from_completion`    | Next occurrence = completion time + interval                         | "7 days after last completion" → if completed Wednesday, next = next Wednesday |

For `from_completion` mode, the RRULE defines the interval (e.g., `FREQ=WEEKLY;INTERVAL=1`) and anchor_time defines the time-of-day. The date advances from the completion moment, but the time snaps to anchor_time.

### Mark Done — Recurring Task (Advance in Place)

When a recurring task is marked done:

1. Capture `before_state` snapshot (current `due_at`, `original_due_at`, etc.)
2. Compute next occurrence (see Recurrence Computation Rules below)
3. Set `due_at` = next occurrence
4. Clear `original_due_at` (snooze is consumed)
5. Leave `done = 0` (recurring tasks are never "done" — they advance)
6. Write to `completions` table: `{task_id, completed_at: now, due_at_was, due_at_next}`
7. Write to `undo_log`: `{action: 'done', fields_changed: ['due_at', 'original_due_at'], before_state, after_state}`

**No webhook. No external correction. No metadata parsing.**

### Mark Done — One-Off Task

When a one-off task is marked done:

1. Set `done = 1`, `done_at = now`, `archived_at = now`
2. Write to `undo_log`

### Recurrence Computation Rules

The next occurrence is NOT simply `rrule.after(now)`. Custom logic is required for the overdue cases:

**For `from_due` mode:**

```typescript
function computeNextOccurrence(task: Task, completedAt: Date): Date {
  const rule = RRule.fromString(task.rrule)

  // Simple case: rrule.after(completedAt) gives the next future occurrence
  let next = rule.after(completedAt, false) // false = exclusive (not including completedAt)

  // Special case RD-003/RD-004: daily tasks completed on the day they're overdue
  // If completed BEFORE today's anchor time → next = today at anchor time
  // If completed AFTER today's anchor time → next = rrule.after(completedAt)
  // The rrule.after() already handles this correctly for daily tasks
  // because BYHOUR=9 means the next 9:00 after now.

  // For weekly tasks (RD-005): rrule.after() with BYDAY=MO returns next Monday.
  // For monthly tasks (RD-006): rrule.after() with BYMONTHDAY=1 returns next 1st.
  // DOM overflow (RD-007): rrule.js handles BYMONTHDAY=31 → last day of short months.

  return next
}
```

**Key insight:** If the RRULE correctly encodes BYHOUR, BYDAY, BYMONTHDAY, then `rrule.after(completedAt)` naturally handles most anti-drift cases. The anchor fields are primarily for display and migration, not computation. The RRULE IS the anti-drift mechanism.

**For `from_completion` mode:**

```typescript
function computeNextFromCompletion(task: Task, completedAt: Date): Date {
  // Parse interval from RRULE (e.g., FREQ=WEEKLY;INTERVAL=1 → 7 days)
  const rule = RRule.fromString(task.rrule)
  // Advance from completedAt by the interval
  let next = rule.after(completedAt, false)
  // Snap time to anchor_time (local time)
  const { hour, minute } = parseAnchorTime(task.anchor_time)
  next = setLocalTime(next, hour, minute, 0, 0)
  return next
}
```

### Multi-Day-Per-Week Patterns

For `FREQ=WEEKLY;BYDAY=MO,WE,FR`: marking done on Monday → next = Wednesday (not next Monday). `rrule.after()` handles this correctly because it returns the next occurrence matching ANY of the BYDAY values.

### Overdue Catch-Up

If a task is overdue by multiple days (e.g., 5 days), marking done skips all missed occurrences and advances to the **next future occurrence.** No catch-up of individual missed days.

### Changing Recurrence

When a task's `rrule` is edited via PATCH:

1. New RRULE is validated (must parse without error)
2. Anchor fields are re-derived from the new RRULE
3. **`due_at` handling depends on overdue status:**
   - **Overdue tasks:** `due_at` preserved unchanged (task remains overdue)
   - **Non-overdue tasks:** `due_at` auto-computed to next occurrence
4. `original_due_at` is cleared (schedule change = new baseline)
5. `snooze_count` is NOT reset (it's a lifetime stat)
6. Change is logged to `undo_log`

### Converting Between Recurring and One-Off

| Change              | Behavior                                                               |
| ------------------- | ---------------------------------------------------------------------- |
| Recurring → one-off | Clear `rrule`, `anchor_*`, `recurrence_mode`. Keep current `due_at`.   |
| One-off → recurring | Set `rrule`, derive `anchor_*`. Recompute `due_at` to next occurrence. |

### Validation Rules

- Recurring tasks MUST have a `due_at` (otherwise when is the first occurrence?)
- `rrule` must parse without error via `rrule.js`
- `recurrence_mode` must be `'from_due'` or `'from_completion'`
- One-off tasks MAY have NULL `due_at` (no-due-date tasks in Inbox)

---

## Snooze System

### First-Class Snooze

Snooze is an explicit operation, not an implicit due date mutation.

**Snooze action:**

1. If `original_due_at` is NULL (first snooze): save current `due_at` to `original_due_at`
2. If `original_due_at` is already set (re-snooze): keep existing `original_due_at` (preserves original)
3. Set `due_at` to the snooze target time
4. Increment `snooze_count` (on EVERY snooze, not just the first)
5. Log to `undo_log` with `fields_changed: ['due_at', 'original_due_at', 'snooze_count']`

**Mark done on snoozed recurring task:**

1. Compute next occurrence from RRULE (ignoring the snoozed `due_at`)
2. Clear `original_due_at`
3. `snooze_count` is NOT reset (it's a lifetime stat for tracking how often a task gets snoozed)
4. Anti-drift is guaranteed because the RRULE — not `due_at` — drives the computation

### PATCH with due_at is a Snooze

When a task's `due_at` is changed via PATCH (without an `rrule` change), snooze logic is applied automatically:

- `original_due_at` is set if not already set
- `snooze_count` is incremented

This means any due date change (whether via the explicit snooze API or via task edit) is tracked as a snooze.

### Snooze Tracking Cleared on RRULE Change

When a task's `rrule` is changed:

- `original_due_at` is cleared (the new schedule establishes a new baseline)
- `snooze_count` is NOT reset (it's a lifetime stat)

This applies to both single-task updates and bulk edits.

### Snooze Validation

- Snooze target to past IS allowed — the task will appear overdue. This enables increment/decrement time adjustments without validation errors.
- Only active tasks (`done = 0`, `deleted_at IS NULL`) can be snoozed.

### Snooze Presets

| Preset        | Behavior                            |
| ------------- | ----------------------------------- |
| +1 hour       | `now` + 1 hour, with hour rounding  |
| +2 hours      | `now` + 2 hours, with hour rounding |
| +3 hours      | `now` + 3 hours, with hour rounding |
| Tomorrow 9 AM | Tomorrow at 09:00 user local time   |
| +1 day        | Current `due_at` + 24 hours         |
| +3 days       | Current `due_at` + 72 hours         |
| +1 week       | Current `due_at` + 7 days           |
| Custom        | Date/time picker                    |

**Hour rounding:** All relative-hour presets (+1h, +2h, +3h) snap to the nearest whole hour. See **Web UI: Snooze Rounding** for the precise rule. Rounding is client-side — the server always receives an absolute datetime.

---

## Undo / Redo

### Design

Every mutating action writes to `undo_log` before applying changes. Each log entry captures the `fields_changed` and the `before_state`/`after_state` for all affected tasks.

**Undo** = for each affected task, restore only the `fields_changed` to their `before_state` values. Mark the log entry as `undone = 1`.

**Redo** = for each affected task, restore only the `fields_changed` to their `after_state` values. Mark the log entry as `undone = 0`.

This is **surgical undo** — if you mark a task done (changing `due_at`, `original_due_at`) and then someone edits the title, undoing the mark-done restores `due_at` and `original_due_at` without affecting the title edit.

### Undo/Redo Stack Semantics

Standard undo/redo stack:

- Undo reverses the most recent non-undone action
- Multiple undos walk backward through history
- Redo replays the most recently undone action
- Multiple redos walk forward through undone actions
- **Any new action clears the redo stack** (all `undone = 1` entries that are newer than the new action become permanently undone)

### Scope

- Undo/redo is **per-user** — User A's undo never affects User B's tasks or history
- No practical limit on depth (undo log entries purged after 30 days)
- Bulk operations = single undo entry (one undo reverses the entire batch)

### Undo of Recurring Mark-Done

This is the most complex case. When a recurring task is marked done:

- `due_at` advanced from "today 8 AM" to "tomorrow 8 AM"
- `original_due_at` was cleared
- A `completions` record was created

Undoing this:

1. Restore `due_at` to the before-state value ("today 8 AM")
2. Restore `original_due_at` to the before-state value (if it was snoozed)
3. Delete the `completions` record (tracked in the undo snapshot)
4. Mark undo_log entry as `undone = 1`

### What's Undoable

| Action                | Fields Changed                                       | Undo Behavior                                                              |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Mark done (recurring) | `due_at`, `original_due_at`                          | Restore previous due_at, restore original_due_at, delete completion record |
| Mark done (one-off)   | `done`, `done_at`, `archived_at`                     | Set done=0, clear done_at, clear archived_at                               |
| Snooze                | `due_at`, `original_due_at`, `snooze_count`          | Restore previous due_at, original_due_at, and snooze_count                 |
| Edit                  | varies (title, priority, etc.)                       | Restore changed fields only                                                |
| Delete                | `deleted_at`                                         | Clear deleted_at                                                           |
| Create                | (new row)                                            | Set deleted_at (move to trash)                                             |
| Bulk done             | per-task `due_at`, `original_due_at`                 | Restore all tasks' changed fields                                          |
| Bulk snooze           | per-task `due_at`, `original_due_at`, `snooze_count` | Restore all tasks' changed fields                                          |

---

## Trash and Archive

### Trash (Soft Delete)

- `DELETE /tasks/:id` sets `deleted_at = now` (soft delete)
- Trashed tasks are hidden from all normal views (dashboard, project, review)
- Trash is viewable and restorable via dedicated trash view and `POST /api/tasks/:id/restore`
- Automatic purge after 30 days (configurable)
- "Empty Trash" = permanent delete of all trashed tasks
- Deleting a project: all tasks in the project are moved to Inbox, then the project is deleted

### Archive

- **One-off tasks:** Archived automatically when marked done (`archived_at = now`, `done = 1`)
- **Recurring tasks:** Never archived. They advance in place and are always "active."
- Archive is viewable via UI and API (`GET /api/tasks?archived=true`)
- Archived tasks are searchable

---

## Projects and Organization

### Default Projects (Seeded)

| Project      | Purpose                          | Shared        | sort_order |
| ------------ | -------------------------------- | ------------- | ---------- |
| **Inbox**    | Unsorted tasks awaiting triage   | No (per-user) | 0          |
| **Routine**  | Recurring tasks — things to DO   | No (per-user) | 1          |
| **Remember** | Recurring tasks — things to READ | No (per-user) | 2          |
| **One-offs** | Non-recurring tasks              | No (per-user) | 3          |
| **Family**   | Shared family tasks              | Yes           | 4          |

Each user gets their own Inbox, Routine, Remember, and One-offs. Family is shared.

### Default Project for New Tasks

New tasks created without a `project_id` default to the user's **Inbox**.

### Project Rules

- Every task belongs to exactly one project
- Projects have a `sort_order` for display ordering
- Shared projects are visible to all users
- No nested projects (flat hierarchy)
- Cannot delete a project that is a user's Inbox (prevent orphaned tasks)

### Title Prefix Convention

Recurring tasks use time-of-day prefixes in their titles: `[EM]`, `[M]`, `[LM]`, `[A]`, `[EE]`, `[E]`. These are a **naming convention**, not a database field. No special handling in the backend — they're part of the title string. A future enhancement could add a first-class `time_block` field.

---

## Notifications

### Architecture

Notification polling runs **in-process** within the Next.js server via `node-cron`. No separate service or systemd unit.

### Overdue Alerts

- **Channel:** Web Push (browser-native, no third-party relay)
- **Trigger:** Cron job every minute checks for undone tasks past their `due_at`
- **Cooldown:** Priority-based per task (P4: 5m, P3: 15m, P0-P2: 30m, per-task override available)
- **Scope:** Per-user (each user gets alerts for their own tasks + shared project tasks)

### Critical Alerts

- **Channel:** APNs with `time-sensitive` interruption level (breaks through iOS Focus mode)
- **Trigger:** Overdue P4 (Urgent) tasks — checked every minute alongside regular overdue notifications
- **Cooldown:** 60 minutes per task via `last_critical_alert_at` (independent of Web Push cooldown)
- **Use sparingly:** School pickup, medication, hard deadlines only
- **No per-task toggle needed:** Setting a task to Urgent (P4) priority is the mechanism. If it's worth bypassing DND, make it Urgent.

---

## Review Workflow (Claude Code)

### Overview

The review workflow is the primary daily interaction pattern. Trent runs a review command via Claude Code 3x/day, processing 80-150 tasks per session.

### Two-Project Architecture

The review workflow is **decoupled from the OpenTask application:**

| Project              | Purpose                                                  | Location                          |
| -------------------- | -------------------------------------------------------- | --------------------------------- |
| **OpenTask**         | The task management app (backend + frontend + API)       | `~/working_dir/opentask/`         |
| **OpenTask Manager** | Claude's management scripts (CLI, review, notifications) | `~/working_dir/opentask-manager/` |

OpenTask Manager talks to OpenTask via its REST API.

### Review Endpoint (GET /api/review)

Returns a structured JSON response for Claude to format and present:

```json
{
  "generated_at": "2026-01-31T14:30:00Z",
  "session_id": "rev_abc123",
  "total_tasks": 147,
  "groups": [
    {
      "name": "ROUTINE",
      "project_id": 1,
      "tasks": [
        {
          "seq": 1,
          "id": 42,
          "title": "[M] Morning routine",
          "due_at": "2026-01-31T14:00:00Z",
          "anchor_time": "08:00",
          "priority": 0,
          "is_overdue": true,
          "is_snoozed": true,
          "original_due_at": "2026-01-31T14:00:00Z",
          "rrule": "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
          "labels": [],
          "notes_preview": "2026-01-29: Not urgent this week"
        }
      ]
    },
    { "name": "REMEMBER", "tasks": [...] },
    { "name": "ONE-OFFS", "tasks": [...] },
    { "name": "INBOX", "tasks": [...] }
  ]
}
```

**`session_id`**: Stable identifier for this review. Used by `POST /api/review/execute` to validate that the sequential numbers still map to the correct task IDs. If tasks have changed since the review was generated, the execute endpoint returns an error with details about what changed.

**Sequential numbers (`seq`):** Assigned in display order across all groups. Used by Claude for compact action expressions (`--done 1-63`). The execute endpoint maps seq → task ID using the session.

### Review Execute Endpoint (POST /api/review/execute)

```json
{
  "session_id": "rev_abc123",
  "actions": {
    "done": [1, 2, 3, "4-63"],
    "snooze": { "ids": [64, 65, "66-98"], "until": "2026-02-01T15:00:00Z" },
    "priority_high": [99],
    "priority_low": [100],
    "delete": [101]
  }
}
```

Ranges like `"4-63"` are expanded server-side. All actions execute in a single transaction as a single undo entry.

### Review Flow

1. Claude calls `GET /api/review` → receives grouped, numbered tasks
2. Claude formats and presents to Trent
3. Trent gives instructions: "Mark 1-63 done, snooze 64-98 to tomorrow 9 AM"
4. Claude calls `POST /api/review/execute` with the session_id and actions
5. Server validates session freshness, executes atomically, returns diff summary
6. Claude presents the diff to Trent

### What's Different From Vikunja

| Before (Vikunja)                               | After (OpenTask)                          |
| ---------------------------------------------- | ----------------------------------------- |
| Individual API calls in parallel ("fast mode") | Single batch endpoint, transactional      |
| `safe_update_task()` on every write            | PATCH semantics, no field corruption risk |
| Webhook service for CANONICAL correction       | No correction needed — RRULE is native    |
| File-based ID map (`.tmp/id_map.json`)         | API-backed session with staleness check   |
| 50-item pagination workaround                  | No cap (returns all undone tasks)         |
| Counter-based system event tracking            | No webhook echo problem                   |

---

## API Design

### Principles

- **RESTful** with JSON payloads
- **PATCH for updates** — only include fields you want to change; omitted fields are untouched
- **Batch endpoints** for bulk operations (transactional)
- **Consistent error format:** `{ "error": "message", "code": "ERROR_CODE", "details": {...} }`
- **Dual auth:** Session cookie (web UI) OR `Authorization: Bearer <token>` (CLI/API)

### Core Endpoints

```
Auth:
  POST   /api/auth/login              -- body: {username, password} → session cookie
  POST   /api/auth/logout             -- clear session
  GET    /api/auth/me                 -- current user info

Tasks:
  GET    /api/tasks                   -- list with filters (see below)
  POST   /api/tasks                   -- create (body: {title, due_at?, rrule?, project_id?, priority?, labels?})
  GET    /api/tasks/:id               -- get single task
  PATCH  /api/tasks/:id               -- partial update (only included fields change)
  DELETE /api/tasks/:id               -- soft delete (trash)

  POST   /api/tasks/:id/done          -- mark done (handles recurrence)
  POST   /api/tasks/:id/undone        -- mark undone (one-offs only; recurring tasks use undo)
  POST   /api/tasks/:id/snooze        -- body: {until: "ISO8601"} (absolute datetime only; rounding is client-side)
  POST   /api/tasks/:id/restore       -- restore from trash

Bulk:
  POST   /api/tasks/bulk/done         -- body: {ids: [1,2,3]}
  POST   /api/tasks/bulk/snooze       -- body: {ids: [1,2,3], until: "ISO8601"}
  POST   /api/tasks/bulk/edit         -- body: {ids: [1,2,3], changes: {priority: 3}}
  POST   /api/tasks/bulk/delete       -- body: {ids: [1,2,3]}

Notes:
  GET    /api/tasks/:id/notes         -- list notes for task
  POST   /api/tasks/:id/notes         -- body: {content: "..."}

Projects:
  GET    /api/projects                -- list user's projects + shared projects
  POST   /api/projects                -- create
  PATCH  /api/projects/:id            -- update
  DELETE /api/projects/:id            -- delete (moves tasks to Inbox first)

Undo:
  POST   /api/undo                    -- undo last action → returns {undone_action, diff}
  POST   /api/redo                    -- redo last undone → returns {redone_action, diff}
  GET    /api/undo/history            -- list recent actions (for undo timeline UI)

Review:
  GET    /api/review                  -- grouped, sorted, numbered task list with session_id
  POST   /api/review/execute          -- body: {session_id, actions: {...}} → atomic execution

Completions:
  GET    /api/completions             -- query params: date, task_id → completion history
```

### Task Creation Request Body

```json
{
  "title": "[M] Take vitamins",
  "due_at": "2026-02-01T15:00:00Z",
  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  "recurrence_mode": "from_due",
  "project_id": 1,
  "priority": 2,
  "labels": ["health"]
}
```

- `title` is required. All other fields optional.
- If `project_id` is omitted, defaults to user's Inbox.
- If `rrule` is provided, `anchor_*` fields are derived automatically by the server.
- If `rrule` is provided but `due_at` is omitted, server computes `due_at` as the next occurrence from now.

### Filter Parameters for GET /api/tasks

| Parameter   | Type    | Description                              |
| ----------- | ------- | ---------------------------------------- |
| `project`   | integer | Filter by project ID                     |
| `done`      | boolean | Include completed tasks (default: false) |
| `overdue`   | boolean | Only overdue tasks                       |
| `recurring` | boolean | Only recurring tasks                     |
| `one_off`   | boolean | Only non-recurring tasks                 |
| `search`    | string  | Case-insensitive title substring search  |
| `label`     | string  | Filter by label                          |
| `trashed`   | boolean | Show trashed tasks (default: false)      |
| `archived`  | boolean | Show archived tasks (default: false)     |
| `limit`     | integer | Max results (default 200, max 1000)      |
| `offset`    | integer | Pagination offset                        |

### Error Response Format

```json
{
  "error": "Task not found",
  "code": "NOT_FOUND",
  "details": { "task_id": 42 }
}
```

Standard codes: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT` (e.g., stale review session), `INTERNAL_ERROR`.

---

## Web UI / PWA

### Design Philosophy

**Triage-first, not list-first.** The primary interaction is batch processing: see a group of tasks, mark some done, snooze the rest. The UI is optimized for this pattern — not for managing individual tasks (that's either Claude's job via CLI, or the task detail view).

Trent's daily pattern: 150+ tasks across groups, 100+ of which are reminders (acknowledge and mark read). The most common actions are "mark all of these done" and "push everything back an hour." The UI must make these one- or two-tap operations.

### Navigation

**Mobile (bottom tab bar):**
| Tab | Icon | View |
|-----|------|------|
| Dashboard | Home | Today's tasks (triage view) |
| Projects | Folder | Project list → project view |
| Add | + (FAB) | Quick add modal |
| History | Clock | Undo timeline + completion history |
| Settings | Gear | User settings, trash, archive |

**Desktop (sidebar):**

- Dashboard
- Projects (expandable list showing each project)
- Archive
- Trash
- Undo History
- Settings

### Dashboard View

The primary view. Shows today's tasks grouped by project, optimized for batch triage.

**Layout:**

```
┌──────────────────────────────────────────────────────┐
│ Good morning, Trent                   🔍  ↩ ↪  👤    │
├──────────────────────────────────────────────────────┤
│ ⬤ 59 overdue                                        │
├──────────────────────────────────────────────────────┤
│ ROUTINE  ·  12 overdue  ·  8 upcoming     ☐ All  ▼  │
│ ┌──────────────────────────────────────────────────┐ │
│ │ ☐  8:00 AM  [M] Morning routine              ! │ │
│ │ ☐  8:00 AM  [M] Take vitamins                  │ │
│ │ ☐  9:00 AM  [LM] Check calendar                │ │
│ │ ─── now (10:30 AM) ─────────────────────────── │ │
│ │ ○  4:00 PM  [A] Help with homework              │ │
│ │ ○  5:00 PM  [EE] Start dinner                   │ │
│ └──────────────────────────────────────────────────┘ │
│ REMEMBER  ·  47 overdue  ·  12 upcoming   ☐ All  ▼  │
│ ┌──────────────────────────────────────────────────┐ │
│ │ ☐  8:00 AM  [M] "Stay focused on one thing"     │ │
│ │ ☐  8:00 AM  [M] "Don't check email first"       │ │
│ │ ... (47 items)                                   │ │
│ └──────────────────────────────────────────────────┘ │
│ ONE-OFFS  ·  3 overdue                    ☐ All  ▼  │
│ ┌──────────────────────────────────────────────────┐ │
│ │ ☐  Jan 27  Call dentist                  (3d)  ! │ │
│ │ ☐  Jan 28  Order new vacuum filter       (2d)    │ │
│ └──────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│ Dashboard  Projects  +  History  Settings            │
└──────────────────────────────────────────────────────┘
```

**Group headers** show: group name, overdue count, upcoming count, "Select All" checkbox, and collapse toggle. The "Select All" checkbox selects all items in that group and activates the floating action bar.

**Sorting within groups (default):**

1. Priority: urgent/high at top
2. Overdue before upcoming
3. By date (earliest first)
4. By anchor_time (for same-day tasks)
5. Low priority separator before low-priority items

**Per-group sort override** (toggle via sort icon on group header). Overrides the default compound sort above with a single-field sort:

- By priority (highest first)
- By title (alphabetical)
- By age (oldest first — useful for one-offs that keep getting snoozed)

When no override is active, the default compound sort applies. Sort preference persists per group per user.

### Task Row

Each task row displays:

```
☐  8:00 AM  [M] Morning routine  !  ↻  [snoozed]  🕐
│     │            │              │   │      │       │
│     │            │              │   │      │       └─ Snooze button (tap opens snooze sheet)
│     │            │              │   │      └─ Snoozed indicator (if original_due_at is set)
│     │            │              │   └─ Recurrence indicator (if recurring)
│     │            │              └─ Priority: ! (high), ‼ (urgent)
│     │            └─ Task title with prefix
│     └─ Time (anchor_time for today, date for overdue from other days)
└─ Checkbox (tap to mark done in normal mode, toggles selection in select mode)
```

**Overdue tasks:** Row background has subtle red tint. Time shown in red.

**Notes indicator:** Small icon if the task has notes. Notes content is visible in the task detail view, not on the row.

**Snooze button:** The clock icon at the end of the row opens the snooze sheet for that individual task. This is the way to do a custom single-task snooze from the dashboard (as opposed to swipe-left, which is a quick +1h).

**In selection mode:** The checkbox becomes a selection checkbox. Selected rows get a highlighted background. The entire row is a tap target for selection (all other interactive elements — checkbox, snooze button — are disabled). Swipe gestures are also disabled.

### Swipe Gestures (Mobile)

Only active when NOT in selection mode. In selection mode, the entire row is a selection target.

| Gesture     | Action           | Visual                                                                            |
| ----------- | ---------------- | --------------------------------------------------------------------------------- |
| Swipe right | Mark done        | Green background, checkmark icon. Completes on full swipe or tap revealed button. |
| Swipe left  | Quick snooze +1h | Blue background, clock icon. Snoozes with hour rounding (see Snooze Rounding).    |

**Swipe threshold:** 40% of row width for full-swipe auto-action. Less than 40% reveals action button.

**Undo toast:** Bottom toast appears for 5 seconds after any swipe action: "Marked done — UNDO" or "Snoozed +1h — UNDO". Tapping UNDO immediately reverses.

**No swipe-to-delete.** Delete requires task detail view → explicit delete button. Prevents accidental data loss.

### Selection Mode and Floating Action Bar

Selection mode is the primary mechanism for bulk operations. When any item is selected, a floating action bar slides up from the bottom of the screen.

#### Entering Selection Mode

- **Mobile:** Long-press (400ms) on any task row → enters selection mode, selects that task, sets it as the anchor
- **Desktop:** Shift+click or Cmd/Ctrl+click on any task row
- **Either:** Tap "Select All" checkbox on a group header → selects all items in that group

#### Selection Interactions

**Desktop:**

| Input                        | Behavior                                                                                                          | Additive?                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Shift+click                  | Range select from anchor to target (inclusive)                                                                    | No — replaces current selection with the range |
| Cmd/Ctrl+click               | Toggle single item (flip its state, keep others)                                                                  | Yes — adds to / removes from current selection |
| Plain click (in select mode) | Select only this item (clears all others). If clicking the only selected item, deselects it and exits select mode | No                                             |
| Escape                       | Exit selection mode, clear all                                                                                    | —                                              |

**Mobile:**

| Input                | Behavior                                                                                                         | Additive?                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Long-press (400ms)   | First: enters select mode + selects item. Subsequent: range select from anchor to target                         | Yes — always additive on mobile |
| Tap (in select mode) | Select only this item (clears all others). If tapping the only selected item, deselects it and exits select mode | No                              |

#### Anchor Behavior

The anchor tracks the last selection point and enables range selection:

1. First selection action sets the anchor to that task
2. Range selection (Shift+click or subsequent long-press) selects all tasks between anchor and target, inclusive, in display order
3. Anchor advances to the target after each range operation
4. This enables chaining: long-press item 1 → long-press item 9 (selects 1-9) → long-press item 20 (adds 9-20)

**Example — selecting two non-contiguous ranges on mobile:**

```
Items: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20

Long-press 1     → selects [1], anchor=1
Long-press 9     → selects [1-9], anchor=9
Tap 7            → deselects 7, selection=[1-6, 8-9]
Long-press 13    → adds [9-13], selection=[1-6, 8-13], anchor=13
Long-press 20    → adds [13-20], selection=[1-6, 8-20], anchor=20
```

#### Group-Level Selection

Each group header has a "Select All" checkbox:

- **Unchecked → checked:** Selects all items in that group (additive to any existing selection in other groups). Sets anchor to the last item in the group.
- **Checked → unchecked:** Deselects all items in that group
- **Indeterminate state:** Shown when some but not all items in the group are selected

#### Floating Action Bar

A rounded floating rectangle near the bottom of the screen. Slides up when any item is selected. Positioned above the bottom tab bar (mobile) to avoid conflicts.

```
┌──────────────────────────────────────────────────────┐
│  12 selected     ✓ Done    +1h    +2h    9AM    ···  │
└──────────────────────────────────────────────────────┘
```

| Button   | Action                                                                             |
| -------- | ---------------------------------------------------------------------------------- |
| **Done** | Mark all selected tasks done. Shows undo toast. Clears selection.                  |
| **+1h**  | Snooze all selected +1 hour (with rounding). Shows undo toast. Clears selection.   |
| **+2h**  | Snooze all selected +2 hours (with rounding). Shows undo toast. Clears selection.  |
| **9AM**  | Snooze all selected to tomorrow 9:00 AM. Shows undo toast. Clears selection.       |
| **···**  | Overflow menu: Priority High, Priority Low, Delete, Move to Project, Custom Snooze |

**Custom Snooze** (in overflow): Opens the snooze sheet with full preset list and date/time picker, applying to all selected tasks.

All bulk actions from the floating bar execute as a single API call and produce a single undo entry.

#### Exiting Selection Mode

- Press Escape (desktop)
- Deselect the last selected item via plain tap (auto-exits)
- After executing a bulk action (Done, Snooze, etc.) — selection clears and bar hides

**While in selection mode**, task detail view is not accessible. Tapping a row toggles selection. To view task details, exit selection mode first.

### Snooze Rounding (Client-Side)

When snoozing by relative-hour duration (+1h, +2h, +3h), the target time snaps to the nearest whole hour:

```
Target time minutes < 35  →  round down to :00 of that hour
Target time minutes >= 35 →  round up to :00 of next hour

Examples (snooze +1h):
  Current 1:20 PM → target 2:20 PM → rounds to 2:00 PM  (20 < 35)
  Current 1:40 PM → target 2:40 PM → rounds to 3:00 PM  (40 >= 35)

Examples (snooze +2h):
  Current 1:20 PM → target 3:20 PM → rounds to 3:00 PM  (20 < 35)
  Current 1:40 PM → target 3:40 PM → rounds to 4:00 PM  (40 >= 35)
```

This is a **client-side behavior** applied by the web UI and CLI presets. The server receives and validates an absolute datetime — it has no opinion about rounding. Claude's CLI may or may not apply rounding depending on context.

### Snooze Sheet (Bottom Sheet on Mobile)

Opened by: tapping a task row's snooze action, or "Custom Snooze" from the floating action bar overflow.

```
┌────────────────────────────────────────┐
│ Snooze "[M] Morning routine"           │
│ (or "Snooze 12 tasks")                 │
├────────────────────────────────────────┤
│  +1 hour    +2 hours    +3 hours       │
│  Tomorrow 9AM    +1 day    +3 days     │
├────────────────────────────────────────┤
│  Pick date & time...                   │
└────────────────────────────────────────┘
```

### Task Detail View

Full-screen view opened by tapping a task row (outside the checkbox).

```
┌────────────────────────────────────────┐
│ ← Back                        🗑 Delete│
├────────────────────────────────────────┤
│ Title: [M] Morning routine             │  ← Editable inline (tap to edit)
│                                        │
│ Due: Jan 31, 2026 at 8:00 AM          │  ← Tap to open date/time picker
│ Recurrence: Daily at 8:00 AM          │  ← Tap to open recurrence editor
│ Priority: ○ Low ● Medium ○ High ○ Urg │  ← Segmented control
│ Project: Routine                    ▼  │  ← Dropdown
│ Labels: health, morning                │  ← Tag input
│                                        │
│ ── Notes ──────────────────────────── │
│ 2026-01-29: Not urgent this week       │
│ 2026-01-14: Ordered new vitamins       │
│                                        │
│ + Add note...                          │  ← Text input
├────────────────────────────────────────┤
│ Created: Jan 10, 2026                  │
│ Snoozed from: 8:00 AM → 10:00 AM      │  ← Only shown if snoozed
└────────────────────────────────────────┘
```

### Recurrence Editor (UI Form)

Structured form, not raw RRULE input:

```
┌────────────────────────────────────────┐
│ Frequency:  [Daily ▼]                  │
│                                        │
│ (If Weekly:)                           │
│ Days:  ☐M ☐T ☐W ☐T ☐F ☐S ☐S         │
│                                        │
│ (If Monthly:)                          │
│ Day of month: [1 ▼]                    │
│                                        │
│ Every: [1 ▼] [week(s)/month(s)]       │  ← Interval
│                                        │
│ Time: [09:00 AM]                       │
│                                        │
│ Mode: ○ From due date                  │
│       ○ From completion                │
│                                        │
│ [Save]  [Cancel]                       │
└────────────────────────────────────────┘
```

The form generates the RRULE string. Users never see the raw RRULE.

### Undo Timeline View

Read-only audit log showing recent actions. Tapping an entry shows what changed.

```
┌────────────────────────────────────────┐
│ Activity History                       │
├────────────────────────────────────────┤
│ ● 10:32 AM  Marked 63 tasks done      │  ← Most recent
│ ● 10:30 AM  Snoozed 35 tasks          │
│ ○ 10:28 AM  Changed priority on 2...  │  ← ○ = has been undone
│ ● Yesterday  Created "Call dentist"    │
│ ...                                    │
└────────────────────────────────────────┘
```

The most recent non-undone action can be undone from here. But this is primarily for visibility, not for selective undo (which is not supported — standard linear undo stack).

### Search

- **Desktop:** Always-visible search bar in header
- **Mobile:** Search icon in header; tapping expands to full-width search bar
- Debounced (200ms) as-you-type search
- Results shown inline replacing the current view content
- Searches task titles (case-insensitive substring match)
- Press Escape or tap X to clear search and return to previous view

### Empty States

| State                | Message                                            |
| -------------------- | -------------------------------------------------- |
| No tasks today       | "All clear! Nothing due today."                    |
| No overdue tasks     | (Overdue badge hidden, not shown with 0)           |
| No tasks in project  | "No tasks in {project}. Create one?" with + button |
| Empty search results | "No tasks matching '{query}'"                      |
| Empty trash          | "Trash is empty"                                   |

### PWA Requirements (v1)

- Installable on iOS (Add to Home Screen) and Android
- App icon from `opentask-text-logo-abbr.png`
- Web app manifest with `display: "standalone"`, theme color
- **Offline: show "Offline" banner. No offline mutation queuing for v1.** (Deferred — offline queuing is complex and not needed for a system that's always on the home network)

### Tech

- ShadCN components (Button, Card, Dialog, Sheet, Select, Tabs, etc.)
- Tailwind CSS for layout and custom styling
- Responsive breakpoints: mobile-first, desktop enhancement
- Dark mode: follow system preference for v1 (no manual toggle)
- Gesture library: `@use-gesture/react` for swipe interactions (Phase 3)

---

## CLI Tool

### Purpose

The CLI is Claude Code's primary interface to OpenTask. It communicates via HTTP to the OpenTask API using a Bearer token stored in an environment variable (`OPENTASK_TOKEN`).

### Configuration

```bash
export OPENTASK_URL="https://your-domain.example.com"
export OPENTASK_TOKEN="<api-token>"
```

### Command Structure

```bash
opentask list [--overdue] [--today] [--recurring] [--one-off] [--search "..."] [--all]
opentask add "Title" [--at "9 AM"] [--project routine] [--rrule "FREQ=DAILY;..."]
opentask done <id_or_search>
opentask undone <id_or_search>
opentask snooze <id> --at "9 AM" [--tomorrow]
opentask snooze <id> --minutes 60
opentask edit <id> [--title "..."] [--priority high] [--project ...]
opentask delete <id> [-y]
opentask show <id>
opentask note <id> "text"
opentask notes <id>

# Bulk operations
opentask bulk-done <id1> <id2> ...
opentask bulk-snooze <id1> <id2> ... --at "9 AM"
opentask bulk-edit <id1> <id2> ... --priority high

# Review workflow
opentask review                    # Grouped, numbered task list
opentask review-exec --done 1-63 --snooze 64-98 [--dry-run]

# Undo
opentask undo
opentask redo
opentask undo-history

# Info
opentask completions [--today] [--date 2026-01-30]
```

### Task Resolution

Single-task commands accept either a numeric ID or a title substring:

- Numeric: `opentask done 42` → operates on task #42
- Search: `opentask done "Morning routine"` → searches titles
- **Multiple matches:** Returns JSON array of candidates with IDs and titles. Claude picks the right one and retries with the numeric ID. No interactive prompt (Claude can't interact with those).

---

## Behavioral Specifications

These are the testable behaviors that define correct system operation. Each has a spec ID for test linkage.

### Recurrence: Anti-Drift (RD)

**RD-001: Snooze Does Not Affect Recurrence**
Snoozing a recurring task changes only `due_at` and `original_due_at`. The RRULE and anchor fields are never modified by snooze.

```
Task: id=42, rrule="FREQ=DAILY;BYHOUR=8", anchor_time="08:00", due_at=today 08:00
Action: Snooze to 14:00
Result: due_at=today 14:00, original_due_at=today 08:00, rrule unchanged, anchor_time unchanged
```

**RD-002: Done Computes From RRULE, Not due_at**
When a recurring task is marked done, the next occurrence is computed from the RRULE pattern. Snooze drift is impossible.

```
Task: rrule="FREQ=DAILY;BYHOUR=8", due_at=today 14:00 (was snoozed)
Action: Mark done at 15:00
Result: due_at=tomorrow 08:00 (from RRULE, not from snoozed 14:00)
```

**RD-003: Overdue Completed Before Anchor Today**
If a daily task is overdue and completed before today's anchor time, next = today at anchor time.

```
Task: anchor_time=08:00, due_at=yesterday 08:00
Action: Mark done at 07:30 today
Result: due_at = today 08:00
```

**RD-004: Overdue Completed After Anchor Today**
If a daily task is overdue and completed after today's anchor time, next = tomorrow at anchor time.

```
Task: anchor_time=08:00, due_at=yesterday 08:00
Action: Mark done at 10:00 today
Result: due_at = tomorrow 08:00
```

**RD-005: Weekly DOW Preservation**
Weekly tasks land on the correct day-of-week after completion, regardless of when completed.

```
Task: rrule="FREQ=WEEKLY;BYDAY=MO;BYHOUR=10", anchor_dow=Monday
Action: Snoozed to Wednesday, marked done on Wednesday
Result: due_at = next Monday 10:00 (not next Wednesday)
```

**RD-006: Monthly DOM Preservation**
Monthly tasks land on the correct day-of-month after completion.

```
Task: rrule="FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9", anchor_dom=1
Action: Snoozed to Jan 5, marked done on Jan 5
Result: due_at = Feb 1 09:00 (not Feb 5)
```

**RD-007: DOM Overflow / Last Day of Month**
For tasks intended to run on the last day of each month, use `BYMONTHDAY=-1` (negative offset = last day). Do NOT use `BYMONTHDAY=31` — rrule.js follows RFC 5545 strictly and skips months with fewer than 31 days (e.g., after Jan 31, the next occurrence would be Mar 31, skipping February entirely).

```
Task: rrule="FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9", anchor_dom=31
Result in February: due_at = Feb 28 09:00 (or Feb 29 in leap year)
Result in April: due_at = Apr 30 09:00
```

**Migration note:** When converting Vikunja tasks with `CANONICAL_DOM: 31` (or 30, 29), generate `BYMONTHDAY=-1` if the intent is "last day of month." For DOM values ≤ 28, use the literal `BYMONTHDAY` value.

**RD-008: Multi-Day Weekly Pattern**
For BYDAY with multiple days, next occurrence is the next matching day, not the next week.

```
Task: rrule="FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9"
Action: Mark done on Monday
Result: due_at = Wednesday 09:00 (same week, not next Monday)
```

**RD-009: Overdue Catch-Up Skips Missed**
Multi-day overdue tasks skip all missed occurrences and advance to the next future one.

```
Task: rrule="FREQ=DAILY;BYHOUR=9", due_at=5 days ago
Action: Mark done at 10:00 today
Result: due_at = tomorrow 09:00 (not yesterday, not today)
```

**RD-010: Non-Recurring Tasks Excluded**
One-off tasks are not affected by recurrence logic. Mark done = set done=1. No advancement.

**RD-011: Overdue Task + rrule Change Keeps due_at Unchanged**
When changing the `rrule` of an overdue task, `due_at` is preserved unchanged. This prevents tasks from "escaping" overdue status by silently jumping to the future when only the schedule is changing.

**RD-012: Non-Overdue Task + rrule Change Auto-Computes due_at**
When changing the `rrule` of a non-overdue task (due_at in the future or null), `due_at` is automatically computed to the next occurrence of the new pattern.

**RD-013: Task with null due_at + rrule Change Computes First Occurrence**
When adding an `rrule` to a task that has no `due_at`, the `due_at` is computed as the first occurrence from now.

### Snooze (SN)

**SN-001: First Snooze Captures Original**
First snooze saves original `due_at` to `original_due_at`.

```
Task: due_at=today 08:00, original_due_at=NULL
Action: Snooze to 14:00
Result: due_at=today 14:00, original_due_at=today 08:00
```

**SN-002: Re-Snooze Preserves Original**
Subsequent snoozes keep the original `original_due_at`.

```
Task: due_at=today 14:00, original_due_at=today 08:00
Action: Snooze to 16:00
Result: due_at=today 16:00, original_due_at=today 08:00 (not 14:00)
```

**SN-003: Done Clears Snooze**
Marking a snoozed recurring task done clears `original_due_at`.

```
Task: due_at=today 14:00, original_due_at=today 08:00, recurring
Action: Mark done
Result: due_at=tomorrow 08:00, original_due_at=NULL
```

**SN-004: Snooze Allows Past Time**
Snoozing to a time in the past is allowed. The task will appear overdue immediately. This enables users to freely adjust due dates using increment/decrement controls without validation errors.

**SN-005: Only Active Tasks Can Be Snoozed**
Cannot snooze done or trashed tasks. Returns 400 error.

**SN-006: Snooze Count Increments on Every Snooze**
`snooze_count` increments on EVERY snooze, not just the first. This is a lifetime stat tracking how often a task gets snoozed.

**SN-007: PATCH with due_at Change Applies Snooze Logic**
When updating a task via PATCH with a `due_at` change (and no `rrule` change), snooze logic is applied automatically: `original_due_at` is set if not already set, `snooze_count` is incremented.

**SN-008: Multiple Field Changes in One Undo Entry**
When changing multiple fields including `due_at` in one PATCH, a single undo entry is created with all changes.

**SN-009: Undo Restores snooze_count**
Undoing a snooze restores `snooze_count` to its previous value along with `due_at` and `original_due_at`.

**SN-010: PATCH with rrule Change Does NOT Apply Snooze Logic**
When changing `rrule`, snooze logic is NOT applied even if `due_at` changes, because changing the recurrence rule is a schedule change, not a snooze.

**SN-011: Snoozed Task + rrule Change Clears Snooze Tracking**
When a snoozed task's `rrule` is changed, `original_due_at` is cleared (schedule change = new baseline). `snooze_count` is NOT reset (it's a lifetime stat).

**SN-012: Add rrule to Snoozed One-Off Task Clears Snooze Tracking**
When converting a snoozed one-off task to recurring by adding an `rrule`, `original_due_at` is cleared and `due_at` is computed to the next occurrence.

### Undo / Redo (UR)

**UR-001: Undo Mark Done (Recurring)**
Undoing a recurring mark-done restores `due_at` and `original_due_at` to before-state. Deletes the completion record.

```
Before done: due_at=today 08:00, original_due_at=NULL
After done: due_at=tomorrow 08:00, original_due_at=NULL
After undo: due_at=today 08:00, original_due_at=NULL
```

**UR-002: Undo Mark Done (One-Off)**
Undoing a one-off mark-done restores `done=0`, clears `done_at` and `archived_at`.

**UR-003: Undo Snooze**
Undoing a snooze restores `due_at` and `original_due_at` to before-state.

```
Before snooze: due_at=today 08:00, original_due_at=NULL
After snooze: due_at=today 14:00, original_due_at=today 08:00
After undo: due_at=today 08:00, original_due_at=NULL
```

**UR-004: Undo Is Surgical**
Undo only restores the fields that the original action changed. Other fields edited since the action are preserved.

```
Action 1: Mark task done (changes due_at, original_due_at)
Action 2: Edit task title to "New Title"
Undo Action 1: due_at and original_due_at restored, title stays "New Title"
```

**UR-005: Undo Bulk Done**
Undoing a bulk-done reverses all tasks in the batch with a single undo call.

**UR-006: Redo After Undo**
After undoing, redo re-applies the action.

**UR-007: New Action Clears Redo Stack**
After undoing, performing a new action makes redo unavailable for the undone actions.

**UR-008: Per-User Isolation**
User A's undo history is independent of User B's. Undo never crosses user boundaries.

### Bulk Operations (BO)

**BO-001: Bulk Done Applies Recurrence Logic**
All tasks in a bulk-done have their recurrence correctly computed. No shortcuts.

**BO-002: Bulk Operations Are Atomic**
A bulk operation either succeeds entirely or fails entirely (SQL transaction). Invalid IDs cause the entire batch to fail.

**BO-003: Bulk Done at Scale**
100+ tasks in a single bulk-done without performance degradation or data corruption.

**BO-004: Bulk Operations Are Single Undo Entry**
A bulk-done of 63 tasks is reversed by a single undo action.

**BO-005: Bulk Mixed Types**
Bulk done handles both recurring (advance) and one-off (archive) tasks in the same batch.

### Bulk Edit (BE)

**BE-001: bulkEdit with due_at Changes Applies Snooze Logic**
When `bulkEdit` is called with only `due_at` changes (no `rrule` change), snooze logic is applied: `original_due_at` is set, `snooze_count` incremented for each task.

**BE-002: bulkEdit with due_at + rrule Does NOT Apply Snooze Logic**
When `bulkEdit` includes both `due_at` and `rrule` changes, snooze logic is NOT applied because `rrule` change takes precedence (schedule change).

**BE-003: bulkEdit rrule Change Clears Snooze Tracking**
When `bulkEdit` changes `rrule` on snoozed tasks, snooze tracking (`original_due_at`) is cleared since the schedule change establishes a new baseline. `snooze_count` is NOT reset.

**BE-004: bulkEdit rrule Change on Overdue Tasks Preserves due_at**
When `bulkEdit` changes `rrule` on overdue tasks, `due_at` is preserved (not auto-computed) so tasks remain overdue.

### Data Integrity (DI)

**DI-001: PATCH Semantics**
Updating one field never affects any other field. `PATCH {priority: 3}` changes only priority.

**DI-002: Soft Delete**
`DELETE /tasks/:id` sets `deleted_at`, does not permanently remove the row.

**DI-003: No Silent Data Loss**
No operation silently discards data. Destructive operations (empty trash, permanent delete) require explicit confirmation.

**DI-004: Concurrent Write Safety**
SQLite WAL mode + transactions ensure writes are serialized. Bulk operations hold a write lock for the entire transaction. No data corruption from concurrent access. Lock timeout is 5 seconds with retry.

---

## Testing Strategy

### Test Layers

| Layer               | Tool             | What's Tested                                                                  | Count     |
| ------------------- | ---------------- | ------------------------------------------------------------------------------ | --------- |
| **Behavioral Spec** | Vitest           | 1:1 mapping with spec IDs (RD-001 through DI-004), core logic with real SQLite | ~50 tests |
| **API Integration** | Vitest + fetch() | Real HTTP requests to a live server, real database, real auth                  | ~25 tests |
| **E2E Flows**       | Playwright       | Full user journeys in a real browser against running server                    | ~15 tests |

### The Cardinal Rule: No Faking

**This project has a documented, repeated history of AI-generated test suites where >50% of "integration" tests were fake.** Common failure modes that have occurred across 12+ projects:

1. **Importing route handlers directly** instead of making HTTP requests — bypasses auth middleware, request parsing, Next.js routing. The test calls `GET(req)` instead of `fetch('http://localhost/api/...')`. This is not an integration test.
2. **Asserting response shape instead of specific values** — `expect(body).toHaveProperty('tasks')` or `expect(Array.isArray(body.tasks)).toBe(true)` can never fail. These assert that JavaScript works, not that the feature works.
3. **Not verifying state after mutation** — POST returns 200, test passes. But did the data actually persist? A subsequent GET with specific value assertions is the only way to know.
4. **Mocking or stubbing anything** — `jest.mock()`, `vi.mock()`, `sinon.stub()`, manual test doubles, in-memory database substitutes. If the word "mock" or "stub" appears in an integration test file, the test is fake.
5. **Tests that pass when the feature is broken** — if you can delete the route handler and the test still passes, it tests nothing.

**Every integration and E2E test must be verifiable by breaking the feature and confirming the test fails.** If it doesn't fail, delete it.

### API Integration Tests (~25 tests)

**Infrastructure:** Tests run against a live Next.js server (started via `globalSetup`). Every request uses `fetch('http://localhost:${PORT}/api/...')`. A real SQLite database is used (reset between test suites). Real API tokens from the seed script authenticate requests.

**Prohibited in API integration test files:**

- `import { GET, POST, PATCH, DELETE } from '...'` (handler imports)
- `new NextRequest(...)` or `new Request(...)` (synthetic request construction)
- `vi.mock`, `vi.stub`, `jest.mock`, or any mocking library
- `expect(x).toBeTruthy()`, `expect(x).toBeDefined()`, or other always-true assertions
- Testing only the response code without verifying database state via subsequent GET

#### Auth (3 tests)

| Test                                                       | What breaks if it fails                  | Break-to-verify                    |
| ---------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| Request with no token → 401                                | Auth middleware missing or misconfigured | Remove auth check from middleware  |
| Request with invalid token → 401                           | Token validation broken                  | Accept any token in middleware     |
| Request with User A's token → only User A's tasks returned | User scoping broken                      | Remove `user_id` filter from query |

#### Task CRUD (6 tests)

| Test                                                             | What breaks if it fails                             | Break-to-verify                           |
| ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| POST create task → GET it back → all fields match exactly        | Route wiring, Zod parsing, or DB insert broken      | Change a column name in INSERT            |
| GET with `?project=N` → only tasks from that project             | Filter ignored or wrong column                      | Remove WHERE clause for project           |
| GET with `?search=keyword` → only matching tasks                 | Search broken                                       | Remove LIKE clause                        |
| PATCH `{priority: 3}` → GET → priority is 3, title unchanged     | PATCH overwrites other fields (DI-001 through HTTP) | Use UPDATE SET instead of selective SET   |
| DELETE → GET default list missing it, GET `?trashed=true` has it | Soft delete broken                                  | Hard delete instead of setting deleted_at |
| POST restore → GET default list has it again                     | Restore broken                                      | Don't clear deleted_at                    |

#### Mark Done (3 tests)

| Test                                                                             | What breaks if it fails                     | Break-to-verify                     |
| -------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| POST done on recurring → GET → due_at is specific correct next date              | Recurrence computation broken at HTTP layer | Return 200 without advancing due_at |
| POST done on one-off → GET → done=true, archived_at set                          | One-off completion broken                   | Don't set done=1                    |
| POST done → POST undo → GET → exact original due_at and original_due_at restored | Undo broken at HTTP layer                   | Skip undo_log write                 |

#### Snooze (2 tests)

| Test                                                                   | What breaks if it fails        | Break-to-verify           |
| ---------------------------------------------------------------------- | ------------------------------ | ------------------------- |
| POST snooze → GET → due_at changed, original_due_at is original due_at | Snooze state management broken | Don't set original_due_at |
| POST snooze to past time → 400 error                                   | Validation missing             | Remove future-time check  |

#### Bulk Operations (3 tests)

| Test                                                        | What breaks if it fails | Break-to-verify                             |
| ----------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| POST bulk/done 5 tasks → GET each → all advanced correctly  | Bulk done broken        | Process only first task                     |
| POST bulk/done with one invalid ID → GET all → none changed | Atomicity broken        | Use individual inserts without transaction  |
| POST bulk/done → POST undo once → GET all → all restored    | Bulk undo broken        | Create per-task undo entries instead of one |

#### Notes (2 tests)

| Test                                                         | What breaks if it fails | Break-to-verify             |
| ------------------------------------------------------------ | ----------------------- | --------------------------- |
| POST note → GET notes → content matches                      | Note creation broken    | Wrong task_id in INSERT     |
| PATCH note content → GET → updated; DELETE note → GET → gone | Note edit/delete broken | Don't execute UPDATE/DELETE |

#### Review Workflow (2 tests)

| Test                                                                                                    | What breaks if it fails    | Break-to-verify          |
| ------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------ |
| GET /review → get session_id + seq numbers → POST /review/execute with done list → GET tasks → all done | Review flow broken         | Don't map seq to task_id |
| POST /review/execute with expired/invalid session_id → error                                            | Session validation missing | Accept any session_id    |

#### Completions + Trash (2 tests)

| Test                                                                                     | What breaks if it fails    | Break-to-verify            |
| ---------------------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| Mark recurring done → GET /completions?date=today → entry with correct task_id and dates | Completion logging broken  | Skip completions INSERT    |
| DELETE task → GET /trash → listed → DELETE /trash → GET /trash → empty                   | Trash list or empty broken | Don't filter by deleted_at |

### E2E Playwright Tests (~15 tests)

**Infrastructure:** Tests run against a live dev server in a real Chromium browser. The test database is seeded with known tasks before the suite. Each test verifies actual rendered UI — visible text, element state, navigation.

**Prohibited in E2E test files:**

- `page.evaluate()` to directly manipulate application state (use UI interactions only)
- Asserting on DOM structure or class names instead of visible content
- Skipping login (every flow must authenticate through the real login page)
- `expect(locator).toBeTruthy()` or other existence-only checks without value assertions

#### Authentication (1 test)

| Test                                                                                      | Verifies                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------- |
| Login with valid credentials → dashboard visible; login with wrong password → error shown | Auth flow works end-to-end in browser |

#### Dashboard (2 tests)

| Test                                                                                    | Verifies                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------- |
| After login, tasks appear grouped by project with correct group headers and task counts | Data fetching, grouping logic, rendering |
| Toggle grouping mode (project ↔ time) → groups change, same tasks present               | Grouping toggle wired correctly          |

#### Mark Done (2 tests)

| Test                                                                                                                | Verifies                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Click checkbox on task → task removed from list → undo toast appears → click Undo → task reappears in same position | Done + undo through UI, toast system |
| Click checkbox on recurring task → task stays in list with new due date                                             | Recurring advance renders correctly  |

#### Snooze (2 tests)

| Test                                                                                                         | Verifies                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Click snooze icon → sheet opens with presets → click "+1 hour" → sheet closes → task due time updated in row | Snooze sheet, preset calculation, UI update |
| Click "Pick date & time" → datetime picker appears → select future time → confirm → task updates             | Custom snooze flow                          |

#### Swipe Gestures (2 tests)

| Test                                                                    | Verifies                  |
| ----------------------------------------------------------------------- | ------------------------- |
| Swipe task row right past 40% threshold → task marked done → undo toast | Right-swipe done gesture  |
| Swipe task row left past 40% threshold → task snoozed +1h → undo toast  | Left-swipe snooze gesture |

#### Selection Mode + Floating Action Bar (2 tests)

| Test                                                                                                                                                  | Verifies                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Long-press task → selection mode activates → checkboxes appear → tap 2 more tasks → FAB shows "3 selected" → click Done → all 3 removed → undo toast  | Selection mode entry, multi-select, bulk done via FAB |
| In selection mode, click group "Select All" checkbox → all tasks in group selected → FAB count correct → press Escape → selection cleared, FAB hidden | Group select-all, escape exit                         |

#### Quick Add (1 test)

| Test                                                                                                  | Verifies                         |
| ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| Type task title in quick-add input → press Enter → new task appears in Inbox group with correct title | Quick-add creation, list refresh |

#### Task Detail (2 tests)

| Test                                                                                                                                                     | Verifies                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Click task title → navigate to detail view → all fields displayed (title, due date, priority, project, labels, notes) → click Back → return to dashboard | Detail navigation, field rendering   |
| In detail view, edit title → change priority → verify changes persist after navigating away and back                                                     | Detail editing persists through HTTP |

#### Search (1 test)

| Test                                                                                                           | Verifies                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Click search icon → type query → matching tasks shown, non-matching hidden → clear search → full list restored | Search filtering, clear behavior |

### Behavioral Spec Tests (~50 tests, existing)

These test core business logic by calling `core/` functions directly against a real SQLite database. They are NOT integration tests — they don't go through HTTP. They exist to verify that recurrence computation, undo/redo mechanics, snooze state, bulk atomicity, and data integrity rules are correct at the logic layer.

Each test maps to a spec ID (RD-001 through DI-004). The database is fully reset between tests via `resetDb()` which deletes and recreates the SQLite file.

```typescript
describe('RD-002: Done Computes From RRULE', () => {
  test('snoozed daily task returns to anchor time after completion', () => {
    // Calls markDone() directly, asserts on returned task fields
  })
})
```

### What Must Pass Before Deploy

- All behavioral spec tests (`npm test`)
- All API integration tests (`npm run test:integration`)
- All E2E tests (`npm run test:e2e`)
- TypeScript compiles with zero errors (`npx tsc --noEmit`)

### Test Quality Gate: Break-to-Verify

After writing any new test, the implementer MUST:

1. Run the test — confirm it passes
2. Break the feature under test (comment out the key line, return early, hardcode wrong value)
3. Run the test again — confirm it **fails with a clear assertion error**
4. Restore the feature

If step 3 does not produce a failure, the test is worthless. Delete it and write one that actually tests the behavior. This is not optional — it's the only way to distinguish a real test from a theatrical one.

### rrule.js Validation

Before committing to rrule.js, run these validation tests first:

1. `FREQ=DAILY;BYHOUR=9` → after(now) returns next 9 AM
2. `FREQ=WEEKLY;BYDAY=MO,WE,FR` → after(Monday) returns Wednesday
3. `FREQ=MONTHLY;BYMONTHDAY=31` → in February returns Feb 28
4. `FREQ=MONTHLY;BYDAY=-1FR` → returns last Friday
5. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` → returns every other Monday

If any fail, evaluate alternatives before proceeding.

---

## AI-Developed Application Requirements

**OpenTask is a fully AI-developed application.** Claude Code writes all code, tests, configuration, and documentation. This fundamentally changes how development feedback loops must work.

### Full Visibility Requirement

The AI developer cannot "see" what's happening without explicit tooling. The following MCP servers are configured in `.mcp.json`:

| Tool               | Purpose                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **Playwright MCP** | Visual testing, screenshots, browser automation, console/network monitoring, end-to-end verification |

### Development Workflow

Before marking any task complete:

1. **Backend changes:** Verify via actual API calls (curl, integration tests)
2. **Frontend changes:** Visual inspection via Playwright screenshots or Chrome DevTools snapshot
3. **Console errors:** Zero tolerance — check via Chrome DevTools, fix all before proceeding
4. **Network requests:** Verify actual HTTP calls succeed, not just mock assertions

### Integration Testing Philosophy

**Integration tests must be real, not theatrical. This has been the single most consistent failure mode across 12+ AI-developed projects: the AI generates tests that look comprehensive but don't actually test anything.** The failure is not malicious — it's a systematic bias toward writing tests that assert on the test infrastructure itself (mocks, stubs, synthetic requests) rather than on the real system's behavior.

**Explicit prohibition list for integration and E2E tests:**

| Prohibited                                    | Why                                           | What to do instead                                                   |
| --------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `import { GET, POST } from '@/app/api/...'`   | Bypasses HTTP, auth, middleware               | Use `fetch('http://localhost:PORT/api/...')`                         |
| `new NextRequest(...)` / `new Request(...)`   | Synthetic request, not real HTTP              | Use `fetch()`                                                        |
| `vi.mock(...)` / `jest.mock(...)` / any mock  | Replaces real behavior with fake              | Don't mock anything. Ever.                                           |
| `vi.stub(...)` / `sinon.stub(...)` / any stub | Same as mocking                               | Use the real implementation                                          |
| `expect(x).toBeTruthy()` / `.toBeDefined()`   | Almost impossible to fail                     | Assert specific values: `expect(task.title).toBe('Morning routine')` |
| `expect(res.ok).toBe(true)` without GET after | Response could lie; DB might not have changed | Always GET after mutation and assert on retrieved values             |
| `page.evaluate(() => setState(...))` in E2E   | Bypasses the UI interaction being tested      | Use click/type/swipe through Playwright                              |
| Asserting on CSS classes or DOM structure     | Brittle, doesn't test behavior                | Assert on visible text and element state                             |

### Test Quality Verification

A test suite is only valid if breaking the system causes test failures. Every test must be verified by:

1. Temporarily break the feature being tested
2. Confirm tests fail with a clear assertion error
3. If tests still pass when the system is broken, the tests are worthless — delete and rewrite

This break-to-verify step is **mandatory after writing each test**, not a one-time audit. The test tables in the Testing Strategy section include a "Break-to-verify" column documenting exactly what to break for each test.

### Build Tools When Needed

If existing tools don't provide sufficient visibility, the AI developer should create:

- Helper scripts for common verification tasks
- Test utilities that hit real endpoints
- Development aids that surface runtime behavior

---

## Build Phases

### Phase 1: Backend Core

**Goal:** Fully functional via API. Claude can manage tasks.

- [ ] Project setup (Next.js, TypeScript, SQLite, better-sqlite3, rrule.js + luxon, Vitest)
- [ ] Database schema + seed script (users, default projects, API tokens)
- [ ] Core business logic (`core/`): recurrence (with timezone-aware rrule.js), undo engine, snooze state, validation
- [ ] Auth middleware (Bearer token + NextAuth JWT, dual-auth `getAuthUser()`)
- [ ] Task CRUD API endpoints (with PATCH semantics)
- [ ] Bulk API endpoints (done, snooze, edit, delete — all transactional, all through undo engine)
- [ ] Undo/redo API endpoints
- [ ] Notes + Projects API endpoints
- [ ] Behavioral spec tests (RD-_, SN-_, UR-_, BO-_, DI-\*)

**Gate 1** (after auth): curl an authenticated endpoint, get 200. Unauthenticated gets 401.
**Gate 2** (after full API): All tests pass. Full walkthrough via curl: create, list, done, snooze, undo, bulk-done.

**Deferred from Phase 1:** Review workflow endpoints (GET/POST /api/review) — Claude uses GET /api/tasks + bulk endpoints directly. Completions query endpoint — table is populated by mark-done, query endpoint built later.

### Phase 1.5: Data Migration

**Goal:** Real data in the system. Build UI against actual tasks, not test data.

- [ ] Migration script: export all undone Vikunja tasks, convert to OpenTask format with RRULEs
- [ ] Validation report: source data + generated RRULE + computed next occurrence + pass/fail per task
- [ ] Run against dev instance first, then production

**Gate 3:** Task counts match Vikunja. Spot-check 10 specific tasks. Trent reviews validation report (15 min).

### Phase 2: Web UI Basics

**Goal:** Usable web interface. Trent can see and interact with real tasks.

- [ ] Auth (login page, NextAuth setup)
- [ ] Dashboard view (grouped task list with real data, overdue badge, now separator)
- [ ] Task row component (checkbox, time, title, priority, recurrence indicator, snooze button)
- [ ] Mark done via checkbox click (with undo toast)
- [ ] Snooze (clock icon → snooze sheet with presets)
- [ ] Quick-add task (title-only inline form)
- [ ] Task detail view (view-only for Phase 2 — display all fields and notes)

**Gate 4:** Log in, see real tasks grouped correctly, mark some done, snooze one, undo. Trent reviews (20 min).

**Deferred from Phase 2:** Full task detail editing (edits via Claude + API), search UI (API search works, UI deferred), recurrence editor UI, full add-task form with due date/project/recurrence.

### Phase 3: Mobile Polish + Interactions

**Goal:** Pleasant mobile experience. Selection mode and bulk operations via UI.

- [ ] Responsive layout (mobile breakpoints, bottom tab bar)
- [ ] Swipe gestures (right = done, left = quick snooze +1h)
- [ ] Selection mode (long-press, range select, anchor system)
- [ ] Floating action bar (Done, +1h, +2h, 9AM, overflow)
- [ ] Group-level Select All / Deselect All
- [ ] Undo/redo buttons in header
- [ ] PWA manifest + service worker (installable, offline banner)

**Ship gate:** Installable on iPhone. Swipe and bulk select work. Floating action bar operational.

### Phase 4: Feature Completion (next week)

- [ ] CLI tool (opentask-manager project, separate repo)
- [ ] Task detail editing UI (inline edit title, priority, project, due date, labels)
- [ ] Full add-task form (due date, project, recurrence, priority)
- [ ] Search UI
- [ ] Review workflow endpoints + scripts (port from Vikunja)
- [x] Notification service (Web Push + APNs, in-process node-cron)
- [ ] Completion history view
- [ ] Undo timeline view
- [ ] Dark mode
- [ ] Kelly's user account + shared project setup

### Phase 5: Optional Enhancements (as time permits)

Fully specced and planned, built when useful. Each is self-contained.

- [ ] Recurrence editor UI (structured form: frequency, days, interval, time, mode → generates RRULE)
- [ ] Animation/transitions (swipe feedback, action bar slide-up, undo toast)
- [ ] Keyboard shortcuts (desktop: j/k navigation, x to select, d to done, s to snooze)
- [ ] Advanced search (by project, label, date range, priority)
- [ ] Performance optimization (virtual scrolling for 150+ task lists)
- [ ] Accessibility audit
- [ ] SWR optimistic updates (instant UI feedback on mutations)

### What "Done for Monday" Means

Phase 1 + Phase 1.5 + Phase 2 minimum. Trent has a working task manager with real data, usable in a browser. Claude can manage tasks via API. Phase 3 makes it good on the phone. Phase 4 brings full feature parity.

---

## Data Migration

### From Vikunja (Before UI Work)

**Scope:** All undone tasks (recurring and one-offs). Migration runs after the API is solid (Gate 2), before UI work begins, so the UI is built against real data.

A migration script will:

1. Export all undone tasks from Vikunja API (paginated)
2. Parse CANONICAL metadata from descriptions (`CANONICAL_TIME`, `CANONICAL_DOW`, `CANONICAL_DOM`)
3. Convert `repeat_after` (seconds) + `repeat_mode` to RRULE strings:
   - `repeat_after=86400` + mode 0 → `FREQ=DAILY;BYHOUR={anchor};BYMINUTE=0`
   - `repeat_after=604800` + mode 0 → `FREQ=WEEKLY;BYDAY={dow};BYHOUR={anchor};BYMINUTE=0`
   - `repeat_mode=1` → `FREQ=MONTHLY;BYMONTHDAY={dom};BYHOUR={anchor};BYMINUTE=0`
   - `repeat_mode=2` (from-completion) → same RRULE + `recurrence_mode='from_completion'`
4. Extract notes from description (before `###`) into notes table
5. Map Vikunja project IDs to OpenTask project IDs
6. Validate: for each migrated task, compute next occurrence via RRULE and compare with Vikunja's expected next. Log discrepancies.

### Priority Mapping

Direct 1:1 mapping (same scale).

---

## Deployment

### Source Control

**Repository:** `https://github.com/trentmcnitt/opentask`

### Deploy Strategy

Dev-first: build and test on dev instance, promote to production after Gate 4 review.

### Production

The Next.js standalone build runs as a systemd service behind a Caddy reverse proxy. SQLite database is stored on local disk. See deployment documentation for environment-specific details.

### Dev Instance

A separate dev instance runs alongside production for pre-release testing.

### Local Development

```bash
cd ~/working_dir/opentask
npm run dev       # Next.js dev server with hot reload
```

### Vikunja Transition

Hard cutover. Vikunja is not in active use. Once all data is migrated and verified, Vikunja can be shut down. No parallel-run period.

---

## Future Enhancements

These are explicitly out of scope for v1. Document here so they're not forgotten.

| Enhancement                      | Notes                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| **VSCode/VSCodium extension**    | Task list sidebar, quick add, mark done from editor.                                |
| **Calendar integration**         | CalDAV server (Baikal) for shared family calendar. See `CALENDAR-SPEC.md`.          |
| **PWA push notifications**       | Done — Web Push is now the primary notification channel.                            |
| **PWA offline mutation queuing** | Queue changes when offline, sync on reconnect. Complex — needs conflict resolution. |
| **Natural language task input**  | "Remind me to call the dentist every 3 months" → auto-generate RRULE.               |
| **Recurring task templates**     | Create a task with preset RRULE, project, priority, prefix.                         |
| **Dashboard widgets**            | Completion streaks, overdue trends, task volume charts.                             |
| **Time block concept**           | Replace prefix system ([M], [E], [A]) with a first-class time block field.          |
| **Reminder vs task distinction** | First-class "reminder" type for items acknowledged, not completed.                  |
| **Bulk acknowledge**             | "Acknowledge all reminders" as a single action instead of marking 60+ done.         |
| **Label management UI**          | Create, rename, delete, color labels. Currently labels are just strings.            |
| **User registration**            | Self-registration flow. Currently users are seeded.                                 |
| **Advanced search**              | Search by project, label, date range, priority. Currently title-only.               |
| **Selective undo**               | Undo a specific action from history, not just the most recent.                      |
