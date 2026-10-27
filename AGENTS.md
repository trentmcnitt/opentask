# OpenTask

Self-hosted task management PWA. This is the authoritative reference for contributing to this codebase. Canonical filename: `AGENTS.md`. `CLAUDE.md` is a one-line import shim (`@AGENTS.md`) for Claude Code — edit this file, not the shim. (Not a symlink: symlinks don't survive every sync tool.)

**Start here:** [Critical Requirements](#critical-requirements) (data-loss prevention), [Commands](#commands) (build/test), [Route Handler Guide](#route-handler-guide) (API patterns), [Development and Testing](#development-and-testing) (what to run when). Reference sections (task model, due dates) are at the end — consult them when working on related features.

See also: `README.md` (project overview), `CONTRIBUTING.md` (quickstart), `TASKS.md` (backlog). Environment-specific details (server addresses, deploy scripts, credentials) are in `CLAUDE.local.md` (gitignored).

## Architecture

Next.js 16 (App Router) + React 19 + React Compiler + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA optimized for iOS. Basic offline support: `public/sw.js` caches the app shell so navigation works offline, but there is no offline data access or mutation queuing. Uses Next.js standalone output mode for deployment. Native companions: an iOS app (`ios/`) that wraps the PWA in a WKWebView and adds APNs push, home-screen widgets, a notification extension, and a watchOS app with its own widgets; and a small native macOS app (`macos/`) with its own widgets. See [iOS and macOS apps](#ios-and-macos-apps-ios-macos).

**v0.3 concepts.** Beyond plain tasks, the app now has **reminders** (recurring nudges grouped by time of day), **quotas** (a count target per day, week, month or year, plus daily **quota prompts** that surface each unmet quota inside a reminder period), and user-editable **periods** (time slots in code) that reminders and prompts are grouped by. The dashboard's front door is **Now** (2026-10-14): open tasks by project, each project showing only what is relevant now — over target, targeted today, in today's Upcoming heads-up, or undated High/Urgent — and folding the rest behind "+ N more in <Project>" (`src/lib/now-view.ts`). The **2026-10-10 task model** splits a task's date into **target** (`due_at`, API `target_at`: when nagging starts), **deadline** (`deadline_at`) and **horizon** (pace), and adds **task segments** on the reminders screen. Since 2026-10-12 a target the user picked makes a task quiet until its date: untargeted one-offs (and deadline tasks on their stored **automatic** target, `target_auto`) sit in their horizon segment (on the user's `check_in_day`), ones with a picked target show only on their **Upcoming** heads-up days, counted from `target_set_at`; the target is never after the deadline, and a repeating task keeps its scheduled `occurrence_at` apart from its target — since 2026-10-21 that occurrence is either the target or, for a repeat with a deadline, the DEADLINE (`repeat_anchor`), the target derived from it by one function, `occurrenceDates` — the date rules all live in `src/lib/task-segments.ts` — see `docs/TASK-MODEL.md` § Deadline, target, horizon. Since 2026-10-25 **Upcoming has two sections**, **Tomorrow** (the day before the anchor) and **Later** (`lead_days` — on ANY dated task now — else the default lead table, before the anchor; carried over until seen), each row's `upcoming_section`; a target-less deadline task is never in Upcoming with the deadlines page drawn (rule 3) — `upcomingDays` / `upcomingState`, see `docs/TASK-MODEL.md` § Upcoming. **On deck** (2026-10-20, behind the task-queue switch) is a target's day without its nag: `on_deck_day` (an OpenTask date), never together with a picked target — a pick clears it (`src/core/tasks/deck-clear.ts`, guarded by OD-G01–G03), the rollover sends an undone one to the queue — see `docs/TASK-MODEL.md` § On deck. **The deadlines page** (2026-10-22, behind the task-queue switch): a deadline with no picked target gets NO automatic target any more — it goes on the `deadlines` task segment from its stored lead day (`lead_from`, `leadFor` in `src/lib/task-segments.ts`), with a safety net from the day before the deadline; `?deadlines=1` opts in; switch off, the automatic target as before — see `docs/TASK-MODEL.md` § The deadlines page. **Repeat ends** (2026-10-22): "after N times" / "on date" live in `repeat_count` / `repeat_count_used` / `repeat_until`, never in the stored rule (COUNT/UNTIL sent in `rrule` are lifted into them); one judge, `repeatStep` / `nextOrEnd` in `src/lib/task-segments.ts`, decides every advance (guarded by RE-G01), and the last occurrence's done or skip ends the series — see `docs/TASK-MODEL.md` § Repeat ends. **Quota enrichment** (2026-10-24): `POST /api/tasks {title, is_tracked: true}` with no rule makes a provisional weekly quota that enrichment fills from the words (count, period, reminder period; a measured amount stays in the title) — the caller declares the kind, the AI never does (`src/core/ai/quota-enrichment.ts`, `docs/AI.md` § Enrichment). **Relative targets** (2026-10-24): a one-off with a deadline may carry `target_days_before` / `target_time` — and `target_slot_id`, the reminder period its time follows (always that period's current start) — its target derived from the deadline by `relativeTargetAt` in `src/lib/task-segments.ts` (the one function deadline-anchored repeats share) and moved with the deadline and with a period retime; any picked date makes it fixed again (guards RT-G01–G03) — see `docs/TASK-MODEL.md` § Relative targets. **Day starts at** (2026-10-23): the OpenTask day's boundary is a user setting (`users.day_start_time` / `day_start_slot_id`, Morning's link-or-custom model plus an unset default — a fixed 3:00 AM for every user since 2026-10-24, `day_start_default` on the wire); a start at or before 12:00 names the day by the date it begins on, after 12:00 by the next date (11 PM: Sunday 23:30 is Monday), and every day boundary goes through `src/lib/opentask-day.ts` (guarded by TQ-G01, `tests/behavioral/tq-day-guard.test.ts`); `rolloverTimeForUser` reads it, and with the task-queue switch on everything keyed to "today" runs on it, the Reminders screen included (roster, "considered today", quota prompts' `prompt_key` dates, a daily quota's count, the slot nag) through one read, `dayBoundaryForUser` (midnight with the switch off). Since "Day starts at" PR 2 (2026-10-24) **everything uses the OpenTask date**: the Now view, the Today pill and counts, date labels, filter chips, Upcoming, horizon segments and `check_in_day`, decks, weekly/monthly/yearly quota periods and the Quotas page, daily stats and History — one pure map from an instant to its date (`openTaskDayOf`, `openTaskLocalDay`, `openTaskDayBoundaries`), calendar maths after it; target and deadline timestamps never move. Day-keyed functions take the day start as a required parameter (no midnight default — TQ-G03): the server passes `dayBoundaryForUser(userId)`, the browser `useDayStart()` (`src/components/PreferencesProvider.tsx`) — see `docs/TASK-MODEL.md` § The OpenTask day. The design spec is `docs/REDESIGN-V03.md` — code comments cite it as `§N` (e.g. `§7.3`), so read the section when you hit one. `docs/TASK-MODEL.md` has the current model; where the spec and the code disagree, the code and `docs/TASK-MODEL.md` win.

**Shelved AI features (2026-10-22, Trent).** What's Next, Insights and Quick Take are **shelved** until they are redesigned: enrichment and Process are the AI features that run. **Process is NOT shelved** (Trent, 10-22: keep it): its AI project and duplicate suggestions (`src/core/ai/process.ts`) are their own feature, `process`, with their own mode (`ai_process_mode`, the Process row in Settings → AI, shown whatever the switch says) and model (`OPENTASK_AI_PROCESS_MODEL`, each `PROCESS` env var falling back to its `INSIGHTS` twin) — see `docs/AI.md` § Process. One server-wide switch, `OPENTASK_AI_UNSHELVE=1`, brings all three back; unset — the default, production, CI, integration and E2E — their nightly jobs are never scheduled, every endpoint of theirs answers `410 { "error": "What's Next, Insights and Quick Take are shelved", "code": "FEATURE_SHELVED" }` (`featureShelved()` in `src/lib/api-response.ts`), `GET /api/user/preferences` reports `ai_unshelved: false`, and the web hides every surface of them. Nothing writes a user's saved AI modes. The code stays in place, dormant, with `SHELVED (2026-10-22)` headers — **do not "fix", re-enable or delete it without Trent.** See `src/core/ai/shelved.ts`.

Additional docs: `docs/REDESIGN-V03.md` (v0.3 redesign spec, cited as `§N` in code), `docs/SPEC.md` (product requirements), `docs/ROADMAP.md` (planned features), `docs/AUTOMATION.md` (external API integration), `DEV_LOG.md` (design decisions and narrative context), `docs/NOTIFICATIONS.md` (push architecture), `docs/IOS-DEV-LOG.md` (iOS history), `docs/openapi.yaml` (REST API schema), `docs/AI.md` (AI architecture and quality testing), `docs/TASK-MODEL.md` (task model reference), `docs/DESIGN.md` (design philosophy).

### Documentation site

The public docs site lives in a separate repo (`opentask-docs`, typically at `~/working_dir/opentask-docs`) (VitePress, deployed to `opentask.mcnitt.io/docs/`). When you change features, API behavior, or configuration in this repo, the docs site may need a corresponding update. Key sync points:

| Change in this repo                          | Update in opentask-docs                             |
| -------------------------------------------- | --------------------------------------------------- |
| API routes or response format                | `openapi.json` (generated from `docs/openapi.yaml`) |
| AI features or provider options              | `setup/ai.md`, `setup/configuration.md`             |
| Environment variables                        | `setup/configuration.md`                            |
| Core behavior (snooze, priority, recurrence) | `concepts/` pages                                   |
| Reminders, quotas, time slots                | `concepts/reminders.md`, `concepts/quotas.md`       |
| iOS app, widgets, Watch, Mac                 | `ios/` pages                                        |
| New feature or major change                  | `overview.md`                                       |

**To sync:** in `opentask-docs`, run `npm run sync` (or `/sync-docs` in Claude Code). It regenerates `openapi.json` from this repo's `main` and lists the commits since the last recorded sync, grouped by docs page. Keep `docs/openapi.yaml` accurate: the docs site's API reference comes straight from it. See `~/working_dir/opentask-docs/AGENTS.md` for the full workflow, build and deploy.

### Source layout

- `src/core/` — Business logic (no UI): auth, db, errors, projects, tasks, labels, time-slots, recurrence, undo, validation, notifications, webhooks, review, stats, ai, activity, export. Quota and reminder logic lives in `src/core/tasks/` (`quotas.ts`, `progress.ts`, `quota-prompts.ts`, `quota-prompt-actions.ts`, `reminders.ts`, `period-rollover.ts`)
- `src/components/` — React components (see directory for full inventory)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode.ts`, `useTimezone.ts`, `useKeyboardNavigation.ts`, etc.)
- `src/app/api/` — REST API routes with three auth methods (Bearer tokens + proxy headers + session cookies)
- `src/app/` — Pages (App Router): root (`/`, the dashboard), reminders, quotas, login, tasks/[id], settings, history, archive, trash
- `src/lib/` — Utilities (`api-response.ts`, `format-task.ts`, `format-date.ts`, `format-rrule.ts`, `logger.ts`, `priority.ts`, `toast.ts`, `utils.ts`, etc.)
- Real-time sync: `emitSyncEvent()` (`src/lib/sync-events.ts`) pushes a change to open browser tabs over Server-Sent Events (`src/app/api/sync/stream/`, `src/hooks/useSyncStream.ts`) and, via `src/core/notifications/widget-push.ts`, to the native widgets as WidgetKit pushes
- `src/types/` — Domain types (`index.ts`), API route types (`api.ts`), NextAuth augmentation (`next-auth.d.ts`), Web Speech API types (`speech-recognition.d.ts`)
- `src/instrumentation.ts` — Next.js server init hook: starts every cron job (overdue and reminder-period notifications, quota period rollover, AI jobs, purges — see [Background jobs](#background-jobs)) and the widget-push listener
- `ios/`, `macos/` — Native apps (see [iOS and macOS apps](#ios-and-macos-apps-ios-macos))
- `assets/` — Source logo and branding files (Pixelmator sources + exported PNGs). After updating source files in `assets/`, copy exports to `public/`.

### UI vocabulary

| Term        | Component                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top bar     | `src/components/Header.tsx`               | Fixed header: count pills (total/overdue/today — overdue and today filter), navigation, and the defer-overdue clock on desktop (`SnoozeOverdueTrigger.tsx`, also the FAB)                                                                                                                                                                                                                                  |
| Quick panel | `src/components/QuickActionPanel.tsx`     | The task editing panel — task detail, the dashboard modal, create panel, reminder detail, and the action bar's Details. Two modes: **this one** (this occurrence: Target / Deadline / On deck rows, `quick-panel/ThisOneFields.tsx`, the pad, the chips) and **every time** (the schedule, `quick-panel/EveryTimePanel.tsx`; in through the "↻ Repeats — … · edit every time ›" link, under a teal banner) |
| Action bar  | `src/components/SelectionActionSheet.tsx` | Floating black bar shown during selection: Done, Details (single selection), More, Trash, Clear. Built on `SelectionBarShell.tsx`, like every surface's bar                                                                                                                                                                                                                                                |

**The UI and the code use different words for the same things** — search for the code word:

| UI says                                     | Code / DB / API says                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Period, "Reminder periods" (Settings)       | Time slot: `time_slots` table, `/api/time-slots`, `slot_id`, `src/core/time-slots/`                                                                                                                                                                                                                                 |
| Quota                                       | Tracked task: `is_tracked`, `progress_*` columns, `isTracked()` in `src/lib/track.ts`, `TrackPanel`, `tr-` tests                                                                                                                                                                                                    |
| Overdue (said "over target" 10-10 to 10-21) | `getCurrentlyDueTaskIds`, `isOverdue`, `counts.overdue`, `?filter=overdue`, `GET /api/tasks?overdue=true`, `snooze-overdue`. The word is `OVERDUE_WORD` in `src/lib/task-model-words.ts`                                                                                                                            |
| Defer (said "Snooze" until 10-21)           | Snooze: `snooze` / `bulk_snooze` actions, `/api/tasks/:id/snooze`, `/api/tasks/bulk/snooze*`, `SnoozeMenu`, `src/lib/snooze.ts`, `sn-` tests. The task-segment "Defer all" is a different action (`segment_deferred_at`, `/api/task-segments/defer`)                                                                |
| Nag (said "auto-snooze" until 10-21)        | `auto_snooze_minutes`, `auto_snooze_<priority>_minutes`, `AutoSnoozePicker`, `AutoSnoozeRow`: how often an overdue notification repeats                                                                                                                                                                             |
| Target                                      | `due_at` (API `target_at`, `due_at` a deprecated alias); re-target = `retarget` (alias `reset_original_due_at`); target age = `original_due_at`                                                                                                                                                                     |
| Task segment                                | `task_segments` in `GET /api/reminders`, `/api/task-segments/*`, `src/core/tasks/task-segments.ts`, `src/lib/task-segments.ts`, `TaskSegmentRow`, `TaskSegmentGroup`, `tm-` tests                                                                                                                                   |
| Horizon                                     | `tasks.horizon` (`days`/`weeks`/`months`/`eventually`, `null` = unset, read as weeks); `HORIZON_WORD` (provisional)                                                                                                                                                                                                 |
| Now / Newest (view toggle)                  | `default_grouping` `'project'` / `'new'` (Now is grouped by project with per-project folds, `src/lib/now-view.ts`, `useNowFolds`; its "Show all" is the old All; `'unified'` is set by the AI-sort toggle, not this one; the retired `'slot'` (Today) and `'time'` are read as `'project'` — `src/lib/grouping.ts`) |

### Database

- **Singleton**: Access via `getDb()` from `@/core/db`
- **Schema**: `src/core/db/schema.sql` — `getDb()` applies this on first call (safe to re-run) using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
- **Config**: `OPENTASK_DB_PATH` env var (default: `data/tasks.db`). See `.env.example` for all env vars.
- **Mode**: WAL (write-ahead logging) for concurrent read performance, 5-second busy timeout (waits for locks to release before failing), foreign keys enforced
- **Operations**: All synchronous (better-sqlite3)
- **JSON columns**: `tasks.labels`, `quota_prompt_config`, `quota_day_state`, `users.label_config` and undo snapshots are stored as TEXT; parse/serialize in application code
- **Labels** also have a registry (`labels` table, `src/core/labels/`): a task label that isn't in the user's registry is rejected

**Schema changes:**

| Change type                                   | Where to make it                            | Notes                                             |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Additive (new table, new column with default) | `src/core/db/schema.sql`                    | Applied automatically on startup (safe to re-run) |
| New column on existing table                  | Both `schema.sql` AND `runMigrations()`     | `hasColumn()` guard in migration                  |
| Destructive (rename/remove column)            | `runMigrations()` in `src/core/db/index.ts` | Add explicit `ALTER TABLE` migration              |

New columns on existing tables need both locations: the `CREATE TABLE` statement (for fresh databases) and an `ALTER TABLE ... ADD COLUMN` in `runMigrations()` (for existing databases).

```ts
// In runMigrations() — each migration is idempotent via hasColumn():
if (!hasColumn(database, 'tasks', 'new_column')) {
  database.exec('ALTER TABLE tasks ADD COLUMN new_column TEXT DEFAULT NULL')
}
```

`runMigrations()` also runs idempotent **data** steps on every startup (`backfillTimeSlots`, `backfillLabelRegistry`, `clearQuotaDueDates`, `migrateQuotaPrompts`, `restoreProjectGrouping`) — each is safe to re-run because its `WHERE`/existence check makes a second run a no-op. Follow that shape for a backfill; there is no versioned migrations table.

**Steps that read the task-queue switch run in the server only.** `OPENTASK_TASK_QUEUE` is set in the server's environment, not a script's, so the data steps that depend on it — `migrateDeadlineTargets`' automatic-target steps (`switchSteps`) and `migrateDeadlineLeads` — run only when `isServerProcess()` (`src/core/db/process-role.ts`: marked first thing in `register()` in `src/instrumentation.ts`, before the database opens). A script that opens the database (the demo reset, `create-token`, the seeds, tests) skips them in both directions and the server applies them at its next start; before 2026-10-24 each script run re-created an automatic target on every deadlines-page task. A new switch-dependent data step goes behind the same check, and a test that needs it calls the step directly or marks the process (`markServerProcess`, `unmarkServerProcess` in `afterEach`). `scripts/simulate-days.ts` marks itself: it plays the server on a copy.

To test schema changes from scratch, delete `data/tasks.db` to force a full rebuild. To test the migration path, run `npm run test:upgrade` (CI's Upgrade job): it opens the previous release's schema and a production-shaped one (`tests/fixtures/schema/prod-shape.sql`, regenerated by `scripts/regen-prod-shape-schema.ts`) with your code, and fails on an error at startup or on any table, column, default or index a fresh database has and the upgraded one lacks — see `tests/upgrade/upgrade.test.ts`. Every other suite builds its databases fresh, so only this one sees an upgrade.

### Authentication

Three auth methods checked in order:

| Condition                                        | Result                                     |
| ------------------------------------------------ | ------------------------------------------ |
| Bearer token present and valid                   | Authenticate via token                     |
| Bearer token present but invalid                 | Return 401 (never fall through to session) |
| No Bearer token, proxy header valid              | Authenticate via proxy (Authelia, etc.)    |
| No Bearer token, proxy header missing or invalid | Fall through to session cookie             |
| Session cookie valid                             | Authenticate via session                   |
| Session cookie missing or invalid                | Return 401                                 |

Proxy header auth is enabled by setting `OPENTASK_PROXY_AUTH_HEADER` to the header name (e.g., `Remote-User`). See `src/core/auth/proxy.ts`.

**Functions** from `@/core/auth`:

- `requireAuth(request)` — Returns `AuthUser` or throws `AuthError`. Preferred for new endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when you need to customize the error response (e.g., returning a different message or status code). Older route handlers use this with a manual null check.

Do not migrate existing `getAuthUser` endpoints to `requireAuth` unless explicitly asked.

`AuthUser` shape: `{ id, email, name, timezone, default_grouping: 'project' | 'unified' | 'new', is_demo: boolean }`. `'project'` is **Now**, the front door and what an unrecognized value coerces to (`coerceGrouping` in `src/lib/grouping.ts`) — it is easy to miss since the view toggle labels it "Now", not "Project": every open task grouped by project, each project showing what is relevant now and folding the rest behind "+ N more in <Project>"; "Show all" lifts the folds (each group then shows the user's `project_preview_count` rows before "Show all N"). `'new'` is Newest: every open task in one flat list, newest added first, whatever the saved sort. The retired `'slot'` (the Today view, today's tasks by time of day, dropped 2026-10-14) and `'time'` (All grouped by due date, 2026-09-29 to 2026-09-30) are accepted on PATCH but stored, returned and shown as `'project'`; new users start on `'project'`.

**Login is username-based.** The login form accepts a username (the `name` column, case-insensitive). Email also works as a login identifier for convenience, but the primary interface is username.

NextAuth is configured in `src/app/api/auth/[...nextauth]/auth.ts` (credentials provider, JWT sessions, custom callbacks). `POST /api/auth/session-from-token` mints a session cookie from a Bearer token, so the native apps' web views stay logged in (`src/core/auth/session-cookie.ts`).

### Security

- **API tokens**: Stored as SHA-256 hashes. The `token` column in `api_tokens` holds the hash; `token_preview` stores the last 8 chars of the raw token for UI display. The raw token is displayed once when generated and cannot be retrieved afterward.
- **Login rate limiting**: In-memory; 5 failures per username in 15 minutes trigger a lockout with exponential backoff (30s, 60s, 120s...).
- **Security headers**: Set in `next.config.ts` and your reverse proxy config: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(self), geolocation=()` (the microphone is allowed for the app's own voice input).
- **JWT sessions**: `maxAge` set to 7 days (NextAuth default is 30 days).

### Background jobs

`src/instrumentation.ts` starts every cron job when the server boots:

- **Every minute:** overdue notifications, reminder-period notifications (`src/core/notifications/slot-reminders.ts`), the named Medium+ reminder pushes (`reminder-nags.ts`, 2026-10-26), the slot nag and the deadlines-page nag (`slot-nags.ts`, `deadline-nags.ts`: both paced by the one nag ladder `nag-ladder.ts` — considering = the user's overdue tier ×2, no quiet hours — and sent when their `nag_sends` row says they are due; every cron sender notifies `notifiableUsers()` only — on, not demo; docs/NOTIFICATIONS.md § The deadlines-page nag). Since 2026-10-26 these five run as ONE coordinated tick (`minute-tick.ts`, `tick.ts`): each plans its sends, the user's highest-ranked send that would sound on its own leads with " · N more waiting" (a silent one — period, Medium reminder, deadlines nag — leads only a minute where nothing sounds) and the rest go out passive (Urgent overdue always critical), and every repeat lands on a clock mark (`nag-marks.ts`; first pushes stay exact) — docs/NOTIFICATIONS.md § Clock marks, § One alert per tick; `scripts/count-pushes.ts` projects a user's day of pushes, counts only. Also: the AI enrichment safety net
- **Every 5 minutes (and at startup):** quota period rollover (`src/core/tasks/period-rollover.ts`) — closes a finished period and resets its count
- **Daily, when AI is enabled — SHELVED (2026-10-22):** What's Next and Insights generation (`src/core/ai/scheduled.ts`), scheduled only with `OPENTASK_AI_UNSHELVE=1`. Shelved (the default), startup logs one line instead and nothing runs nightly — see [Shelved AI features](#architecture)
- **Purges:** `src/core/undo/purge.ts`, `src/core/stats/purge.ts`, `src/core/tasks/purge-completions.ts`, `src/core/tasks/purge-trash.ts`, `src/core/ai/purge.ts`, `src/core/webhooks/purge.ts`, and the slot-nag purge

It also starts the widget-push listener (`initWidgetPushSync()` in `src/core/notifications/widget-push.ts`), which turns sync events into WidgetKit pushes.

## Commands

```bash
npm run dev              # Local dev server (port 3000)
npm run build            # Production build (runs prebuild.ts for build ID, then Next.js standalone)
npm run start            # Start production server (for local testing)
npm run lint             # ESLint
npm run type-check       # tsc --noEmit
npm run format           # Prettier format all files
npm run format:check     # Verify formatting (no changes)
npm test                 # Behavioral tests (vitest, no HTTP/UI)
npm run test:integration # Integration tests (HTTP against built server)
npm run test:upgrade     # Upgrade test: this code on databases older releases made (needs git history)
npm run test:e2e         # Playwright E2E tests (headless)
npm run test:e2e:ui      # Playwright with UI
npm run test:perf        # Dashboard load-time measurement, by hand (not in CI; tests/perf/)
npm run test:quality     # AI prompt quality tests (Layer 1 — see below for setup)
npm run test:quality:retry  # Re-run failed scenarios from last quality run
npm run test:quality:run # Run specific scenarios: npm run test:quality:run -- <id> [id ...]
npm run dump-prompts     # Dump rendered AI prompts to .tmp/ (see docs/AI.md § Quality Testing for flags)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with coverage report
npm run db:seed          # Seed database with initial users and projects
npm run db:seed-dev      # Seed dev user with ~25 realistic tasks (for contributors)
npm run db:seed-demo     # Seed demo user with ~55 generic professional tasks
npm run db:reset-demo    # Delete and re-create all demo user data
npm run db:create-token  # Create API token: npm run db:create-token -- <user> [name]
npx tsx scripts/create-user.ts <username> <password> [email] <timezone>  # Create user; timezone may come from OPENTASK_DEFAULT_TIMEZONE instead
```

**Quick check**: `npm run type-check && npm run lint && npm test`. CI also runs `format:check`; the pre-commit hook formats staged files, so that rarely fails (see [Tooling](#tooling)).

## Critical Requirements

These rules prevent data-loss bugs and security issues. Violating the atomic mutation rule can cause data loss; failing to reject invalid tokens can create security bypasses.

### Every mutation must be atomic and logged for undo

Every task mutation must be logged for undo, and the mutation + log write must be atomic. Core mutation functions (mostly in `src/core/tasks/`; also `src/core/time-slots/edit.ts` and AI enrichment) call both `logAction()` and `withTransaction()` internally. Route handlers call the core mutation function directly — they do not call `logAction()` or `withTransaction()` themselves.

If you create a **new core mutation function**, follow the existing pattern:

```ts
withTransaction((db) => {
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPriority, taskId)
  logAction(user.id, 'edit', 'Updated priority', ['priority'], [snapshot])
})
```

Use `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` to build the before/after snapshot. The `completionId` parameter is only needed when completing a recurring task — it links the `completions` row to the undo snapshot (see `markDone()` in `src/core/tasks/mark-done.ts` for the pattern).

For task creation, pass `{ id: taskId }` as `beforeTask` (there is no full before-state). On undo, the system soft-deletes the task (since there is no before-state to restore). See `createTask()` in `src/core/tasks/create.ts` for the pattern.

For bulk operations, use the corresponding `bulk_*` action type (e.g., `bulk_done`, `bulk_snooze`) and pass an array of snapshots — one per affected task. See `src/core/tasks/bulk.ts` for the pattern. The full set of action types is the `UndoAction` union in `src/types/index.ts`.

**Quota counts use `createQuotaSnapshot()`**, not `createTaskSnapshot()`, for any change to `progress_current`. It records which period the count belonged to, so an undo after the period has rolled over is skipped instead of putting last period's count back (see `docs/TASK-MODEL.md` § Quotas and completion).

**Log an entry even when nothing changed** (a −1 at zero, restoring a prompt that's already waiting). Clients offer Undo on the toast for every tap; without an entry of its own, that Undo would reverse whatever came before it (see `src/core/tasks/progress.ts`).

**After the transaction commits**, a core mutation also calls `emitSyncEvent(userId)` (refreshes open tabs and pushes to widgets) and `dispatchWebhookEvent(...)`, and usually records `logActivity(...)` inside the transaction — see `createTask()`. A mutation that moves a task's `due_at`, completes, skips or deletes it also calls `dismissNotificationsForTasks(userId, ids)` (`@/core/notifications/dismiss`), which clears the delivered notification on every device and resyncs the app-icon badge; one that can change the overdue count without making a banner stale (create, restore, undo/redo) calls `syncBadgeCount(userId)`. Routes never make these calls — the header comment of `dismiss.ts` lists which mutation does which. Pass `emitSyncEvent(userId, { widgets: false })` only for a change no widget can show: iOS budgets widget pushes, so skipping invisible changes saves budget, but a wrongly-skipped push leaves a widget stale.

### All deletions must be soft deletes

Deleting a task always soft-deletes it (set `deleted_at`). Tasks are only hard-deleted by "Empty Trash" — which cannot be undone and must require explicit user confirmation — and by the retention cron that purges trash older than `OPENTASK_RETENTION_TRASH_DAYS` (`src/core/tasks/purge-trash.ts`).

```ts
db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, taskId)
```

These undo and soft-delete requirements apply to task mutations specifically. Outside tasks:

- **Undoable:** editing or deleting a period (time slot) — the entry carries the slot row in `undo_log.slot_state`, and undo restores a deleted slot under its original id.
- **Not undoable:** creating a period; projects (deleting one hard-deletes it and moves each task to its owner's Inbox); labels (hard delete); user preferences, webhooks, API tokens.
- **Deliberately not in the undo log:** the quota period rollover cron (`period-rollover.ts`) — it writes only the activity log.

### Reject invalid tokens immediately

If an Authorization header is present but the token is invalid, return 401 immediately — never fall through to session auth. See the [Authentication](#authentication) section for the full decision table.

### Never suppress lint errors or warnings

Never use `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, or similar suppression comments without explicit approval from the user. Fix the root cause instead. If a fix is genuinely impossible, ask the user before adding any suppression comment.

### No brittle fixes or tolerances

Don't add buffers, timeouts, or tolerances to work around symptoms. If something seems like a race condition or timing issue, understand the actual requirement first. Code should be deterministic and precise, not held together by tolerances and timeouts. For example, if a test fails intermittently, find the ordering or state bug rather than adding `setTimeout` or retry loops. This applies to application code and behavioral tests. For E2E tests, use Playwright's built-in waiting mechanisms (`waitForSelector`, auto-waiting) instead of manual timeouts.

## Conventions

### Naming

- Import alias: `@/` maps to `src/`
- React components: PascalCase (`CreateTaskPanel.tsx`, `TaskRow.tsx`)
- Other source files: kebab-case (`api-response.ts`, `overdue-checker.ts`)
- Types/interfaces: PascalCase (`Task`, `AuthUser`, `UpdateTaskOptions`)
- DB columns: snake_case (`due_at`, `created_at`, `anchor_dow`)
- API fields: snake_case (`project_id`, `original_due_at`)

### Code policies

- Store all dates as UTC in the database. Convert to the user's timezone (from `AuthUser.timezone`) in API responses and UI code.
- When you need a UI primitive not already in `src/components/ui/`, install it with `npx shadcn@latest add <component>`. This generates the file in `src/components/ui/`.
- **Document unintuitive or complex code within the same code file.** Non-obvious behavior (e.g., UX flows, UI layouts, backend behaviors) can be hard to infer from code at a glance. Add a comment block explaining what the behavior is and why, so future readers don't have to reverse-engineer it. Do this as you build or modify features — when in doubt, err on the side of documenting.
- ESLint warns on: `max-lines-per-function: 150` (excluding blank lines and comments), `complexity: 20`, `max-depth: 5`, `max-nested-callbacks: 4`.

### Tooling

- **Pre-commit hook**: `lint-staged` runs Prettier and ESLint on staged files before every commit. If a commit is rejected, fix the issues and retry — do not bypass with `--no-verify`. Common failures: Prettier formatting (fix with `npx prettier --write <files>`), ESLint errors (fix the code, do not suppress).
- **Node version**: Pinned in `.node-version` at the project root.
- **Formatting**: Prettier (semi: false, singleQuote: true, printWidth: 100, Tailwind plugin). CI fails on unformatted files (`format:check`). `.prettierignore` excludes `.claude/`, so `npm run format` from the main checkout leaves other sessions' agent worktrees alone.
- **CI** (`.github/workflows/ci.yml`, on PRs and pushes to `main`): Quality (type-check, lint, format:check), Test, Upgrade, Build, Integration, E2E (three shards on PRs only; the required `E2E` check is their result), Dependency Review. PRs that only touch `ios/` or `macos/` skip the web jobs; `native-logic-tests.yml` runs the Swift `OpenTaskLogicTests` when `ios/`, `macos/` or `tests/fixtures/contract/` change.

## Route Handler Guide

### Route handler pattern

Wrap all route handlers with `withLogging()` from `@/lib/with-logging`, which logs every request with method, path, status, duration, and auth type. Log level varies by status: 5xx → `error`, 4xx → `warn`, 2xx → `info`. Uses the `http` namespace.

`withLogging()` also opens the **request context** (`src/core/request-context.ts`, an `AsyncLocalStorage`): the auth step records the auth method and token, and `logAction()` / `logActivity()` stamp each row with the client that made it (`client`, `token_name` — the `X-OpenTask-Client` header, else `inferClient()` in `src/lib/client-attribution.ts`). Outside a request (cron jobs) a write is `system`; work a request only starts and the system finishes (AI enrichment) runs under `runAsSystem()`.

Preferred pattern for new route handlers:

```ts
import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, badRequest, handleError, handleZodError, parseRouteId } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { updateTask } from '@/core/tasks'
import { validateTaskUpdate } from '@/core/validation'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params // Next.js 16 requires await
    const taskId = parseRouteId(id)
    if (taskId === null) return badRequest('Invalid task ID')
    const input = validateTaskUpdate(await request.json())
    const { task, fieldsChanged, description } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId,
      input,
    })
    return success({
      ...formatTaskResponse(task),
      fields_changed: fieldsChanged,
      description,
    })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'PATCH /api/tasks/:id error:', err)
    return handleError(err)
  }
})
```

Log unexpected errors in the catch-all before calling `handleError()`. Expected errors don't need explicit logging: `ZodError`, and any `AppError` (`AuthError`, `NotFoundError`, …), which `withLogging()` already records as a 4xx.

Note: `updateTask()` handles its own transaction and undo logging internally.

### New route handler checklist

Follow the pattern above, and verify:

- [ ] Use `requireAuth(request)` (preferred for new handlers) or `getAuthUser(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement), and parse an id strictly with `parseRouteId()` from `@/lib/api-response` (digits only; `null` → `badRequest()`, the 400 every `[id]` route returns for a malformed id)
- [ ] Validate request body with validation functions from `@/core/validation` (`validateTaskCreate`, `validateTaskUpdate`, etc. — these call Zod `.parse()` internally)
- [ ] Wrap in try/catch: `ZodError` → `handleZodError()`, else → `handleError()`. `requireAuth()`'s `AuthError` and the core functions' `NotFoundError`, `ForbiddenError` and `ValidationError` all extend `AppError` (`@/core/errors`), so `handleError()` maps them to 401/404/403/400 with no branch of their own.
- [ ] Use PATCH for updates (not PUT)
- [ ] If you created a new core mutation function, ensure it uses `withTransaction()` and calls `logAction()` with before/after snapshots (see [Critical Requirements](#critical-requirements))
- [ ] Format task responses with `formatTaskResponse()` from `@/lib/format-task`
- [ ] If the route mutates data itself rather than through a core function that already does it, call `emitSyncEvent(user.id)` after the write, so open tabs and widgets update
- [ ] Don't dismiss notifications or sync the badge in the route: the core mutations do it (see [Critical Requirements](#every-mutation-must-be-atomic-and-logged-for-undo)). A new core mutation that changes a task's `due_at` or `done`, or deletes it, calls `dismissNotificationsForTasks()` itself
- [ ] Return using response helpers: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()` — success format: `{ data: ... }`, error format: `{ error, code, details? }`
- [ ] Wrap handlers with `withLogging()` from `@/lib/with-logging` (use named function expression for stack traces)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing
- [ ] Update `docs/openapi.yaml` if this adds or changes a public API endpoint
- [ ] If the endpoint is one the native apps call, follow the [contract fixtures rule](#contract-fixtures-rule)

## Development and Testing

### When to run which tests

If a change spans multiple rows in this table, combine the test suites from all matching rows. If a change affects what the user sees on screen (even via a shared utility like `format-task.ts`), treat it as a UI change.

| Change type                                   | What to run                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every change (always run)                     | The [quick check](#commands)                                                                                                                                                                              |
| API routes, core logic, validation, auth      | Quick check + `npm run test:integration`                                                                                                                                                                  |
| Schema or migrations (`src/core/db/`)         | Quick check + `npm run test:integration` + `npm run test:upgrade`                                                                                                                                         |
| AI prompts, enrichment logic, AI behavior     | Quick check + `npm run test:quality` (Layer 1; then perform Layer 2 — see [AI quality testing](#ai-quality-testing))                                                                                      |
| UI components, hooks, styles, client behavior | Quick check + the [related E2E specs](#the-full-e2e-suite-is-cis) + **deploy to dev + [browser verification](#ui-verification)**                                                                          |
| iOS / macOS app (Swift, project.yml)          | Build with `xcodegen` + `xcodebuild`, run the Swift logic tests (`OpenTaskLogicTests`, see `ios/AGENTS.md` § Tests), then manual testing on device.                                                       |
| Refactoring / code reorganization             | Quick check + `npm run test:integration` + the related E2E specs; the full E2E suite runs in CI                                                                                                           |
| Production deploy                             | A `main` commit whose PR passed CI: nothing more. Anything CI hasn't passed (a fix branch shipped before merge): quick check + integration + the related E2E specs, and `test:quality` if AI code changed |

During rapid iteration (deploy, verify in browser, fix, re-deploy), the quick check between deploys is sufficient. Run the full checklist on the final version before reporting results.

E2E tests (run locally) and browser verification (run against dev) are complementary — both are required for UI changes.

Run a single test: `npx vitest tests/behavioral/some-spec.test.ts --run`
Run a single E2E test: `npx playwright test tests/e2e/some.spec.ts`

#### The full E2E suite is CI's

Locally, run the E2E specs you added or changed and the specs for the area you touched (`npx playwright test tests/e2e/a.spec.ts tests/e2e/b.spec.ts`), not the whole suite. CI runs every spec on the PR, split three ways (~7 min), and that result is the gate. A full local run is ~13 min and repeats it. Don't run the suites again before a prod deploy of a `main` commit whose PR passed CI.

**Background long runs, and don't poll.** Start E2E, integration and quality runs with `run_in_background` and keep working or end the turn; the harness reports when the job exits. Never wait in an `until grep …; sleep` loop, and never re-read the output file to check on it. Each check is a full turn at the session's whole context (one week in October had 609 of them).

**Run every E2E spec you added or changed locally, and see it pass, before you push.** A new E2E test that has only ever run in CI tends to fail there first: a pixel-exact position, a time-of-day assumption, a second element with the same label. Each such failure costs Trent a red CI run and a notification email. CI is the second check, not the first. If the change is visible on every page (a new floating button, a layout change), run the whole suite, since other specs can trip over it.

### AI quality testing

**Running quality tests:** Quality tests require `OPENTASK_AI_ENABLED=true`. When running locally with Claude Code installed, SDK mode is the default — no API keys or model env vars are needed:

```bash
OPENTASK_AI_ENABLED=true npm run test:quality
```

For API providers (Anthropic, OpenAI, xAI), you also need `OPENTASK_AI_PROVIDER`, the provider's API key, and per-feature model vars (`OPENTASK_AI_ENRICHMENT_MODEL`, etc.). See `docs/AI.md` § Configuration for all options.

AI quality testing has two layers:

1. **Layer 1** — Automated structural validation (valid JSON, required fields, type checks). Run with `npm run test:quality`.
2. **Layer 2** — LLM-as-judge semantic evaluation using `tests/quality/validator-prompt.md` (scoring 0-10, pass >= 6). Perform manually by following the instructions printed by Layer 1.

Do not report quality tests as complete until both layers pass.

Production has no feedback loop for AI quality — quality testing **is** the quality bar. If a scenario isn't tested, assume it doesn't work. Do not ship prompt changes that degrade quality on existing scenarios.

Always dump and review the rendered prompt before and after any AI prompt change: `npm run dump-prompts -- --feature <feature>`. See `docs/AI.md` § Quality Testing for the full workflow, all `dump-prompts` flags, and targeted re-run commands.

Scenarios live in `tests/quality/scenarios/`, one file per feature (`enrichment-*.ts`, `quick-take.ts`, `insights*.ts`, `whats-next.ts`). The What's Next, Insights and Quick Take scenarios are skipped by default while those features are shelved; include them with `OPENTASK_AI_UNSHELVE=1`.

### Pre-existing test failures

If a test fails that is unrelated to your current change, report it to the user before proceeding. Do not silently skip failing tests. After reporting a pre-existing failure, you may continue with your current work unless instructed otherwise — pre-existing failures do not block checklists or workflows. Do not modify the failing test to make it pass.

### UI verification

**Any UI change must be deployed to dev and verified in the browser before reporting the work as done.** Do not tell the user the work is done, suggest they verify, or ask if they'd like you to deploy — you deploy it, you verify it, you report what you found.

During iterative UI verification deploys to dev, committing between each deploy is not required. Commit once the final verified version is ready, then re-deploy from the clean commit.

**Dev login credentials** are in `.secrets` at the project root. Read that file before logging in via Playwright.

**A UI change is not done until every box is checked.** Note any pre-existing test failures in your results — they do not block this checklist.

- [ ] Quick check passes
- [ ] The related E2E specs pass locally, and the full suite in the PR's CI
- [ ] Deployed to dev environment (see `CLAUDE.local.md` for deploy commands)
- [ ] Playwright: screenshots at desktop (1280x800+) and mobile (375x812) viewports (save to `.tmp/`)
- [ ] Playwright: no console errors/warnings, no failed network requests
- [ ] Interactive flows tested with Playwright (if applicable — clicks, form submissions, state changes)
- [ ] Fixes applied and re-deployed if anything looked wrong
- [ ] Dev link shared with results

Backend/logic-only changes with no UI touchpoint do not need browser verification — passing tests are sufficient.

### Behavioral tests

Location: `tests/behavioral/`

Behavioral tests exercise core logic with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll`, which resets the DB and seeds a test user. Test files run sequentially (not in parallel) because they share a single database.

Helper: `tests/helpers/setup.ts`

### The golden suite and the day simulator

The task model's date rules (target, deadline, horizon segments, Upcoming, attempts, age) are pinned down as a whole, not only rule by rule (`docs/TASK-MODEL.md` § Testing the model):

- **Golden suite** — `tests/golden/*.ts` are dated, day-by-day timelines (what shows where on each local day, when it nags, the attempts and age badges), played by `tests/behavioral/golden.test.ts` through the day simulator against the real core. A change to a date rule that moves any day of any timeline fails here. When a rule changes on purpose, change the timelines with it, from the spec — never by pasting the simulator's output.
- **Day simulator** — `src/core/sim/day-simulator.ts` steps a task list day by day (or hourly) with a policy (`never`, `tap`, `complete-repeating`, `complete`). The seeded invariants in `tests/behavioral/tm-invariants.test.ts` run random lists through it.
- **CLI** — `npx tsx scripts/simulate-days.ts <db> --user <id> --days 61 --policy tap` prints each day's Reminders-screen load (ids only; `--titles` for local use). It never writes to `<db>`: it backs it up to a temp copy, empties the copy's push/APNs/webhook tables, and runs there. Use a `.backup` copy of production, never the live file, and keep that copy out of the repo.

### Integration tests

Location: `tests/integration/`

Integration tests send real HTTP requests to a running `next start` server (the production build). The global setup script (`globalSetup.ts`) builds the app and starts the server automatically on a random port, against `data/test-integration.db` with `OPENTASK_TEST_MODE=1`. These tests authenticate using test-only tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this calls `POST /api/test/reset`, which is only available when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

`tests/integration/contract-fixtures.test.ts` writes and checks the native-app contract fixtures — see the [contract fixtures rule](#contract-fixtures-rule).

### E2E tests

Location: `tests/e2e/`

Playwright with headless Chromium, one test at a time, against a **production build**: the web server is `npm run build && next start -p 3333` (set `E2E_PREBUILT=1` to skip the rebuild when nothing changed). The port defaults to 3333; two runs at once (e.g. from two worktrees) collide unless each sets its own `E2E_PORT` (e.g. `E2E_PORT=3341 npm run test:e2e`) — the build and database are already per worktree. Uses a separate DB (`data/test-e2e.db`), which `tests/e2e/globalSetup.ts` builds and seeds itself. In CI a test that only passes on retry fails the run. The `authenticatedPage` fixture provides a pre-logged-in browser page by logging in via the real login form.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

If navigating away triggers a `beforeunload` dialog, either reset dirty state first (click Reset/Cancel) or use `mcp__playwright__browser_handle_dialog` with `accept: true` to dismiss it.

### Test data seeding

`scripts/seed-test.ts` seeds deterministic data for integration tests (via `POST /api/test/reset`); E2E seeds its own in `tests/e2e/globalSetup.ts`. For development (not testing), `npm run db:seed` (which runs `scripts/seed.ts`) seeds the development database with initial users and projects.

### Test naming conventions

Behavioral tests use 2-letter prefixes for feature areas: `bo-` bulk ops, `sn-` snooze, `sg-` snooze guard, `sk-` skip, `ur-` undo/redo, `rd-` recurrence, `oc-` occurrences, `di-` data integrity, `ai-` AI features, `tr-`/`tk-` quotas (tracked tasks), `qp-` quota prompts, `qn-` quota-prompt notifications, `dn-` the deadlines nag and the nag ladder, `rm-` reminders, `ts-` time slots, `tm-` task model (deadline, target, horizon, task segments), `up-` Upcoming, `bg-` badges (attempts, age), `dv-` dashboard views, `lr-` label registry, `gt-` task queries, `pj-` projects, `cl-` cadence ladder. Utility-focused tests use descriptive names without prefixes.

### Time-based testing

Tests must be **time-agnostic** — they should pass regardless of when they run. Use these patterns:

**Behavioral tests**: Use `vi.setSystemTime()` to freeze the clock at a known moment, and `vi.useRealTimers()` in `afterEach` to restore:

```typescript
beforeEach(() => {
  // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
  vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})
```

**Test data seeding**: Always use future dates for "upcoming" tasks:

```typescript
// WRONG: Could be in the past depending on when tests run
const today5pm = DateTime.now().set({ hour: 17 })

// RIGHT: Always in the future
const tomorrow5pm = DateTime.now().plus({ days: 1 }).set({ hour: 17 })
```

See `tests/behavioral/format-date.test.ts` and `tests/behavioral/bo-bulk.test.ts` for examples.

**"Today" with the task queue on is the OpenTask day, not the calendar date.** Between midnight and the day start (3:00 AM by default) the server's today is still yesterday's date, so an integration or E2E test that computes "today"/"tomorrow" from the calendar fails in that window (CI, on UTC, runs in it). Read the server's day: `openTaskToday(tz)` (`tests/integration/helpers.ts`) or `openTaskDay(page, n)` (`tests/e2e/fixtures.ts`), both the user's `rollover_time` through `openTaskDayOf`. Keep the real 3:00 AM default; don't seed a midnight day start to hide the difference.

**Pinning the server's clock (test mode only).** `POST /api/test/clock { now: ISO | null }` (404 unless `OPENTASK_TEST_MODE=1`; `src/core/test-clock.ts`) shifts the server process's `Date` by a fixed offset, so it runs on from `now`; `null` puts the real clock back. Pin the browser to the same instant with `page.clock.install`. Known gaps: SQL `'now'` defaults still stamp the real time, and the cron jobs compute on the shifted clock for every user — pin at or before real now, and stamp the task rollover first. Reset it in `afterAll` (the E2E global teardown resets it too). `tests/e2e/tq-late-night.spec.ts` uses it to run the deck flows at 01:30.

## Deployment

**Local development:** `npm run dev` starts a hot-reloading server on port 3000.

**Production deployment:** OpenTask uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory. Deploy the built output however you prefer — systemd service, Docker, etc. A `Dockerfile` and `docker-compose.yml` are provided; `.github/workflows/docker-publish.yml` publishes images to GHCR on version tags (CI is described under [Tooling](#tooling)). Schema migrations run automatically on app startup.

**Commit policy for deployments** (overrides the global "only commit when explicitly instructed" rule):

- **Production deploy**: Commit all changes first — rollback depends on checking out a previous commit
- **Iterative dev deploys** (during UI verification): Commits not required between deploys
- **Final dev deploy** (after verification): Commit the verified version, then re-deploy from the clean commit
- If there are uncommitted changes and you need to deploy, ask the user to confirm a commit first

**Rollback:** `git revert HEAD`, then re-deploy. Database migrations are not rolled back — additive schema changes remain in place and are harmless. Destructive migrations (rare) may need manual SQL. Only use `git checkout <sha>` if you need to roll back multiple commits.

See `CLAUDE.local.md` (gitignored) for environment-specific deployment details (server addresses, service names, deploy scripts, database inspection, etc.).

## Task Model & Due Dates

See `docs/TASK-MODEL.md` for the complete task model reference: deadline/target/horizon, task segments, priority values, recurrence, completion behavior, snooze semantics, undo system API, and task access control.

**Deadline, target, horizon (critical for AI work):** `due_at` is the **target** — when nagging starts, soft, moved routinely ("Defer" in the UI since 2026-10-21, "Snooze" before; there is no snooze state, every date change is one move) — at every priority; it is never a deadline. The real cutoff is `deadline_at`: no snooze moves it, and **while it is ahead the target is never after it** — every move stops at the deadline (`capped_at_deadline` / `capped_deadline`). Once it has passed, any target can be picked, and a bulk sweep treats the task as High (`skipped_deadline` counts the ones held back). **A one-off with a deadline always has a stored target**: with none the user picked, the server stores the **automatic** target (`target_auto`: the user's morning 3 days before the deadline, 4 when it is 16+ days out; now if that has passed) and re-derives it when the deadline moves; clearing a picked target on a deadline task is "Back to auto" — with the task-queue switch OFF only (one release, plan A1): with it on there is no automatic target, a deadline task with no target goes on the **deadlines page** from its lead day, and the web says "Remove target" everywhere (2026-10-22). Only a picked target makes a task quiet (Upcoming); an automatic one keeps the horizon rhythm. A repeating task's scheduled occurrence is `occurrence_at`, apart from its target. `horizon` is pace; `null` is unset (read as weeks, never reported as set). Priority is what missing it costs: P3 (and a passed deadline) is bulk-snoozed only when nothing lower is left in the batch, P4 never. Enrichment sets a target only from explicit day/time wording and a deadline or horizon only from explicit wording ("by Friday" is a deadline, its target left automatic). See `docs/TASK-MODEL.md` § Deadline, target, horizon.

**The two badges (2026-10-12, spec §7):** _attempts_ — local days a task was over target ("3×"; counted the moment it goes over, reset by done and each new occurrence, frozen without a target, the 3× row offers "Remove target?" — a deadline task too since 2026-10-22; "Back to auto?" and `attempts_offer: "auto"` are gone) — and _age_ — an undated task past its horizon's threshold (">1 mo"), the same thresholds as Process's growth asks. Attempts are read as of now in `rowToTask`, checkpointed by every target move (`stampTargetSet`) and persisted by a minute cron. See `docs/TASK-MODEL.md` § The two badges.

**Undo system:** See [Critical Requirements](#every-mutation-must-be-atomic-and-logged-for-undo) for the atomic mutation pattern and API, or `docs/TASK-MODEL.md` for the full undo reference.

## Demo User

The demo account showcases OpenTask with curated portfolio-style tasks, plus quotas, reminders, default periods, and pre-generated AI Insights/What's Next. Each user only sees their own data (filtered by `user_id`). The user row has `is_demo = 1`, which keeps it out of scheduled AI generation and widget push.

| Setting       | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Username      | `demo`                                                      |
| Password      | `demo` (shown on login page when `NEXT_PUBLIC_DEMO_MODE=1`) |
| Notifications | Disabled                                                    |
| Reset         | Every 4 hours (via cron)                                    |
| Projects      | Inbox, Try It, Personal, Client Work                        |

**Scripts:**

- `npm run db:seed-demo` — Create the demo user and tasks (run once)
- `npm run db:reset-demo` — Delete and re-create all demo data (cron). Keeps the user row, so sessions stay valid

## iOS and macOS apps (`ios/`, `macos/`)

**iOS** (`ios/`, SwiftUI, iOS 17+ / watchOS 10+) wraps the PWA in a WKWebView and adds APNs push. Five targets:

- `OpenTask` — the main app
- `OpenTaskNotification` — notification content extension
- `OpenTaskWidgets` — home-screen widgets (Reminders, Tasks, Quotas)
- `OpenTaskWatch` — watchOS app with its own UI (Reminders, Tasks and Quotas pages), not just notification handling
- `OpenTaskWatchWidgets` — watchOS Smart Stack widgets, embedded in `OpenTaskWatch`

**macOS** (`macos/`) is a separate native AppKit/SwiftUI app with its own XcodeGen project — not a Catalyst port. Targets: `OpenTaskMac`, `OpenTaskMacWidgets`, and `OpenTaskLogicTests`. It compiles `ios/Shared/` and `ios/OpenTaskWidgets/`, so **a change there ships to the Mac too**. See `macos/README.md`.

**Shared code:** source shared across iOS targets lives in `ios/Shared/`; code shared only by the two watchOS targets lives in `ios/WatchShared/` — not duplicated into either target, and not folded into `ios/Shared/`, which the iOS and Mac targets also compile.

**Build:** `cd ios && xcodegen generate --spec project-sim.yml && xcodegen generate`. `project.yml` is canonical; `project-sim.yml` is generated from it without the watch targets (so it builds without the watchOS SDK) — never hand-edit it. Mac: `cd macos && xcodegen generate`.

**Tests:** pure logic (wire DTOs, `WidgetStore`'s cache, snooze plans, the watch's quota/slot logic) is covered by `OpenTaskLogicTests` — sources in `ios/Tests/Logic/`, run from `macos/` (`ios/AGENTS.md` § Tests has the command). UI and device behavior are tested manually.

`ios/AGENTS.md` has the implementation detail: widget and watch behavior, notification mechanisms, previews, and XcodeBuildMCP workarounds.

### Server endpoints the native apps call

Changes to these require manual testing on the native apps. Nearly every call goes through `ios/Shared/APIClient.swift`.

| Endpoint                                                      | Used for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/session-from-token`                           | Keeping the web view logged in from the stored API token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/user/preferences`                                   | Connection check during setup; label config for the Quotas widget and watch; `check_in_day` (1–7) for the segment hints; `task_queue` / `rollover_time` (read-only, the queue switch and the OpenTask day — cached with `week_start` in `DayStartStore`, and every native "today" runs on it; `day_start_time` / `day_start_slot_id` / `day_start_default` are the setting behind `rollover_time` — unset, 03:00 — and no build reads them); `pad_presets` for the notification snooze grid's preset row (`PadPresetStore`)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST`, `DELETE /api/push/apns/register`                      | Device token registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/push/apns/widget-token`                            | WidgetKit push token registration (`platform` `ios`/`macos`/`watchos`; see `docs/NOTIFICATIONS.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/notifications/actions`                             | Done/snooze/delete from notification action buttons; the named reminder push's Considered (`REMINDER_NAG`, 2026-10-26) sends `done` with `day` (the payload's `reminder_day`) and reads `considered` — `false` (another day, or no longer waiting) changed nothing and is a success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/notifications/dismiss-all`                         | Clearing delivered notifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/tasks/counts`                                       | The app icon / Dock badge on foreground and after a notification action (`overdue`, the Tasks page's red-pill number)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/tasks?done=false`, `GET /api/projects`              | The Tasks and Quotas widgets and watch pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/reminders`                                          | Reminders widget, watch Reminders page and Smart Stack, slot checklist — including `groups[].prompts` and the top-level `task_segments` (with its `upcoming` entry, each row's `recurring` and — 2026-10-25, the Upcoming split — each Upcoming row's `upcoming_section`, `tomorrow` or `later`, Tomorrow's rows first; one kind, so shipped builds list both as one page). Since native PR E (2026-10-26) every native build asks the web's own question, `APIClient.remindersPath` = `REMINDERS_URL` (`src/lib/reminders-query.ts`: `?queue=1&deck=1&handled=1&deadlines=1&fill=1` — the queue's panels, deck rows, left rows with `segment_left`, the `deadlines` segment first with `safety_net` / `seen`, and every kind, an empty one with no rows; guarded by `reminders-query.json`)                                                                                                                                     |
| `POST /api/task-segments/consider`, `/defer`, `/target-today` | A task segment's circle, Defer All and "Today". Body `{ ids }` (`/target-today` also takes an optional `at`, the web's long-press time), the caller's own open tasks only; `/target-today` moves a repeating task's target too (its `occurrence_at` stays), `skipped_recurring` always `[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/task-segments/defer-lead`                          | The deadlines page's Defer (2026-10-22). No native build calls it: native PR E draws the deadlines page but leaves Defer to the app (the row's deep link). Body `{ ids, day? }`; answer `{ day, deferred, refused: [{ id, reason, message }], summary }`; 409 with the task queue off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/time-slots`                                         | Cached in the App Group (`TimeSlotStore`) to build period-snooze actions offline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/completions`                                        | Widgets' "show completed" list (`?since=&until=` for the local day); each row carries `attempts` (days over target when done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`, `PATCH /api/tasks/{id}`                                | Snooze to a time (content extension; stops at the deadline, `capped_at_deadline`); moving a quota prompt to another period (`quota_prompt_config`, merged over the `GET`); the widget outbox reads it back before resending a completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/tasks/{id}/undone`                                 | Restoring a completed task from a DONE row (refuses a quota: 400)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/tasks/{id}/progress`                               | Quota +1/−1, with `source` (`widget`/`watch`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/tasks/bulk/complete`                               | Bulk Done and the slot checklist; its `prompts` field marks quota prompts considered or done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/tasks/bulk/snooze`                                 | Per-row and selected-task snooze; sets `include_task_ids` so explicit picks bypass the P3/P4 sweep filter; every move stops at its deadline (`capped_deadline`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/tasks/bulk/snooze-overdue`                         | "Snooze all overdue" actions; `slot` body field (a slot's `start_time`, or `"next"`); `notify: false` from the Home Screen quick actions (no feedback push); always a sweep (task queue: `queued`, `queued_until`, `snoozed_high_name`, `summary` — the watch and Mac read `queued` / `queued_until` / `summary`); `moved_ids` (2026-10-26, queued included) is the set of banners every native sweep clears, and no others                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/quota-prompts/consider`, `/did`, `/restore`        | Handling a quota prompt and putting it back. Keyed by `prompt_key`, never task id; another day's key is a 400. Consider and did are also the named quota-prompt push's buttons (`QUOTA_NAG`, Push PR 4; native in PR 4b, where the 400 is quiet for Considered and "That was yesterday's" for Did it); a cookie or proxy-header request must be same-origin (403), Bearer is unchecked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/undo`, `POST /api/redo`, `GET /api/undo/status`    | Widget and watch Undo. **Scoped by id** (2026-10-26; native since PR E — each surface sends only its OWN last `undo_id`, `ios/Shared/UndoScope.swift`): every mutation route in this table answers `undo_id` — the undo entry that request wrote, `null` when it logged nothing (all refused, `considered: false`); the newest when a request logs more than one (`requestUndoId`, `src/core/request-context.ts`). `POST /api/undo { id }` / `POST /api/redo { id }` act only if `id` is the entry a bare undo/redo would take (checked inside the transaction), else 409 `CONFLICT` with `details: { reason, newest_undoable_id }` (undo: `not_latest` / `already_undone` / `gone`) or `{ reason, next_redoable_id }` (redo: `not_next` / `not_undone` / `gone`); without `id`, unchanged. Success adds `undone_id` / `redone_id`. Status adds `newest_undoable_id` and `next_redoable_id` (`latest_id` counts undone rows too) |

### Contract fixtures rule

Any change to one of the endpoints above — a field added, renamed, removed or re-typed, or a value's meaning changed — re-runs the fixture writer and commits the fixture diff in the same PR, so the contract change is visible in review:

```bash
CONTRACT_WRITE=1 npx vitest run --config vitest.integration.config.ts tests/integration/contract-fixtures.test.ts
```

The fixtures (`tests/fixtures/contract/*.json`) are the live responses of a fixed synthetic scenario, normalised (ids → integer placeholders, timestamps pinned). Without `CONTRACT_WRITE=1` that test fails on any drift, shape first. They are read by `tests/behavioral/contract-types.test.ts` (against the TS types) and by the Swift `ContractDecodeTests` (against the DTOs, asserting values) — re-run both after rewriting, and update the Swift assertions if a pinned value legitimately changed.

Only some endpoints are captured today: `GET /api/reminders`, `GET /api/tasks?done=false`, `GET /api/time-slots`, `GET /api/completions`, `GET /api/undo/status`, `POST /api/quota-prompts/did`, `POST /api/quota-prompts/consider` (`quota-prompts-consider`; another day's key's 400 is asserted, not captured), `POST /api/quota-prompts/restore`, `POST /api/tasks/bulk/complete` (with `prompts`), `POST /api/tasks/bulk/snooze`, `POST /api/tasks/bulk/snooze-overdue` (with the task queue on, `bulk-snooze-overdue`), `POST /api/tasks/{id}/progress`, `GET /api/reminders` with task segments (`reminders-segments`), `POST /api/task-segments/consider` (`task-segments-consider`), `GET /api/reminders` with an Upcoming segment (`reminders-upcoming`), `POST /api/task-segments/target-today` on a repeating task (`task-segments-target-today-repeating`), `GET /api/tasks/counts`, `GET /api/user/preferences` (minus the server-environment AI fields and `task_queue`), `GET /api/tasks/{id}` for the attempts and age badges (`task-badges`), `GET /api/reminders` with the task queue's two panels, switch on (`reminders-queue`), and with a future deck's Upcoming row, `?deck=1` (`reminders-deck`), and `GET /api/tasks/{id}` for a deadline-anchored repeat (`task-deadline-anchored`), `GET /api/reminders` with the deadlines page, `?deadlines=1` (`reminders-deadlines`), and `POST /api/task-segments/defer-lead` (`task-segments-defer-lead`), and `GET /api/reminders` with both Upcoming sections (`reminders-upcoming-sections`), and `POST /api/notifications/actions` `done` with `day` (`notification-action-considered`, `notification-action-not-waiting`), and `POST /api/undo` with an `id` (`undo-by-id`; the same id again — a 409 `already_undone` — is asserted, not captured), and the native question itself (`reminders-query`, the web's `REMINDERS_URL`; `reminders-native`, its answer on a rich day: every kind, empty ones, left rows, a seen safety-net row, deck and Try Tomorrow rows). Every captured mutation carries its `undo_id`. Changing an uncaptured one is a good moment to add its capture; a new endpoint the apps call should get one from the start.
