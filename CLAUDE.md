# CLAUDE.md

OpenTask is a self-hosted task management PWA. This file is the authoritative reference for contributing to this codebase.

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
npm run test:e2e         # Playwright E2E tests (headless)
npm run test:e2e:ui      # Playwright with UI
npm run test:quality     # AI prompt quality tests (Layer 1 — requires OPENTASK_AI_ENABLED=true)
npm run dump-prompts     # Dump rendered AI prompts to .tmp/ (see AI quality testing)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with coverage report
npm run db:seed          # Seed database with initial users and projects
npm run db:create-token  # Create API token: npm run db:create-token -- <user> [name]
npm run db:migrate-due   # Data migration from the "Due" app
```

**Quick check** (referenced throughout this file): `npm run type-check && npm run lint && npm test`

## Critical Requirements

These rules prevent data-loss bugs and security issues. Violating the atomic mutation rule can cause data loss; violating the auth rule can create security bypasses.

### Every mutation must be atomic and logged for undo

Every task mutation must be logged for undo, and the mutation + log write must be atomic. Core mutation functions in `src/core/tasks/` handle both `logAction()` and `withTransaction()` internally. Route handlers call the core mutation function directly — they do not call `logAction()` or `withTransaction()` themselves.

If you create a **new core mutation function**, follow the existing pattern:

```ts
withTransaction((db) => {
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPriority, taskId)
  logAction(user.id, 'edit', 'Updated priority', ['priority'], [snapshot])
})
```

Use `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` to build the before/after snapshot. The `completionId` parameter is only needed when completing a recurring task — it links the `task_completions` row to the undo snapshot (see `markDone()` in `src/core/tasks/mark-done.ts` for the pattern).

For task creation, pass `{ id: taskId }` as `beforeTask` (there is no full before-state). On undo, the `'create'` action value triggers special handling to soft-delete the task. See `createTask()` in `src/core/tasks/create.ts` for the pattern.

### All deletions must be soft deletes

All task deletions are soft-deletes (set `deleted_at`). The only hard-delete operation is "Empty Trash," which permanently deletes data, cannot be undone, and must require explicit user confirmation.

```ts
db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, taskId)
```

### Reject invalid tokens immediately

If an Authorization header is present but the token is invalid, return 401 immediately — never fall through to session auth. See the [Authentication](#authentication) section for the full decision table.

## Architecture

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA with iOS optimization and basic offline support (`public/sw.js` caches the app shell for navigation fallback; no offline data access or mutation queuing). Uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory for deployment. See `docs/SPEC.md` for product requirements, `docs/ROADMAP.md` for planned features, and `docs/AUTOMATION.md` for external API integration (Shortcuts, Claude Code, scripts).

### Source layout

- `src/core/` — Business logic (no UI): auth, db, tasks, recurrence, undo, validation, notifications, review, stats
- `src/components/` — React components (see directory for full inventory)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode.ts`, `useGroupSort.ts`, `useTimezone.ts`, `useKeyboardNavigation.ts`, etc.)
- `src/app/api/` — REST API routes with dual auth (session cookies + Bearer tokens)
- `src/app/` — Pages (App Router): root (`/`), login, tasks/[id], projects, projects/[id], settings, history, archive, trash
- `src/lib/` — Utilities (`api-response.ts`, `format-task.ts`, `format-date.ts`, `format-rrule.ts`, `logger.ts`, `priority.ts`, `toast.ts`, `utils.ts`, etc.)
- `src/types/` — Domain types (`index.ts`), API route types (`api.ts`), NextAuth augmentation (`next-auth.d.ts`)
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs

### UI vocabulary

| Term        | Component                                 | Description                                                                 |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Quick panel | `src/components/QuickActionPanel.tsx`     | Grid of snooze/priority buttons used in task detail and the dashboard modal |
| Action bar  | `src/components/SelectionActionSheet.tsx` | Floating black bar with Done/Details/More buttons shown during selection    |

### Database

- **Singleton**: Access via `getDb()` from `@/core/db`
- **Schema**: `src/core/db/schema.sql` — `getDb()` applies this idempotently on first call using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
- **Config**: `OPENTASK_DB_PATH` env var (default: `data/tasks.db`). See `.env.example` for all env vars.
- **Mode**: WAL (write-ahead logging) for concurrent read performance, 5-second busy timeout (waits for locks to release before failing), foreign keys enforced
- **Operations**: All synchronous (better-sqlite3)
- **JSON columns**: Labels and undo snapshots are stored as TEXT; parse/serialize in application code

**Schema changes:**

| Change type                                   | Where to make it                            | Notes                                |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| Additive (new table, new column with default) | `src/core/db/schema.sql`                    | Applied idempotently on startup      |
| Destructive (rename/remove column)            | `runMigrations()` in `src/core/db/index.ts` | Add explicit `ALTER TABLE` migration |

For new columns on existing tables, add the column in the `CREATE TABLE` statement (for fresh databases) _and_ an `ALTER TABLE ... ADD COLUMN` in `runMigrations()` (for existing databases). The migration uses `hasColumn()` to check before altering.

To test schema changes from scratch, delete `data/tasks.db` to force a full rebuild.

The app applies schema changes to remote databases automatically on restart.

### Authentication

Dual authentication checked in order:

| Credential      | Valid? | Result                                     |
| --------------- | ------ | ------------------------------------------ |
| Bearer token    | Yes    | Authenticate via token                     |
| Bearer token    | No     | Return 401 (never fall through to session) |
| No Bearer token | —      | Fall through to session cookie             |
| Session cookie  | Yes    | Authenticate via session                   |
| Session cookie  | No     | Return 401                                 |

**Functions** from `@/core/auth`:

- `requireAuth(request)` — Returns `AuthUser` or throws `AuthError`. Preferred for new endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when you need to customize the 401 response (e.g., returning a different message or status code based on context). Most existing route handlers use this with a manual null check.

`AuthUser` shape: `{ id, email, name, timezone, default_grouping: 'time' | 'project' }`.

**Login is username-based, not email-based.** The login form accepts a username (the `name` column, case-insensitive). Email is stored but is not a user-facing login field. Dev credentials are in `.secrets` at the project root.

NextAuth is configured in `src/app/api/auth/[...nextauth]/auth.ts` (credentials provider, JWT sessions, custom callbacks).

## Behavioral Model

OpenTask is not a traditional task manager. Due dates for most tasks are **reminders, not deadlines**. Understanding this is critical for interpreting task data correctly, especially in AI features. See `docs/DESIGN.md` for the full rationale.

**The two-tier due date system:** Priority determines whether a due date is a deadline or a notification trigger.

- **Priority 0-1 (Unset/Low):** `due_at` means "remind me at this time." These tasks are bulk-snoozed on the first click of the snooze button. Being "overdue" just means `due_at` has passed — it's the normal state, not a problem.
- **Priority 2 (Medium):** `due_at` is still a reminder, but gets a second-tier snooze. Medium tasks are only bulk-snoozed on the second click, after P0/P1 are cleared. This gives the user a natural pause to reconsider medium-priority items. `MEDIUM_PRIORITY_THRESHOLD = 2` in `src/lib/priority.ts`.
- **Priority 3-4 (High/Urgent):** `due_at` is a real deadline. These are never bulk-snoozed — they must be snoozed individually, so every due date change is a deliberate decision. Being overdue is significant. `HIGH_PRIORITY_THRESHOLD = 3` in `src/lib/priority.ts`.

**Two-tier bulk snooze flow:** The snooze button in the top bar uses a stateless two-tier system. The server determines the tier from the batch composition:

1. **Tier 1** (first click): If P0/P1 tasks are present, only those are snoozed. P2+ skipped.
2. **Tier 2** (second click): If only P2+ remain, P2 tasks are snoozed. P3/P4 skipped.
3. **Tier 0**: If only P3/P4, nothing is eligible.

**Implications for code and AI:**

- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- The gap between `original_due_at` and `due_at` shows total drift but not how many times or why the task was snoozed. Don't infer deferral counts or intent from dates alone.
- `snooze_count` is a lifetime stat incremented on every snooze (including bulk). High counts are normal, not a sign of avoidance.
- For P0-2 tasks, avoid language like "deferred three times" (implies conscious decisions). Prefer factual framing: "has been on your list for 3 weeks."

## Domain Reference

### Priority values

| Value | Meaning |
| ----- | ------- |
| 0     | Unset   |
| 1     | Low     |
| 2     | Medium  |
| 3     | High    |
| 4     | Urgent  |

### Recurrence model

RFC 5545 RRULE strings (the iCalendar recurrence rule standard, e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`. Anchor fields preserve the intended local time across DST (Daylight Saving Time) transitions (e.g., a task due at 9 AM stays at 9 AM local time when clocks change):

- `anchor_time` — time of day
- `anchor_dow` — day of week
- `anchor_dom` — day of month

`computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement.

### Completion behavior

- **Recurring tasks** advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- **One-off (non-recurring) tasks**: when completed, the app sets `done=1` and `archived_at` to the current time

### Snooze

Snooze sets `due_at` to a new value without modifying recurrence. For recurring tasks, the original schedule is preserved: a daily 9:00 AM task snoozed to noon and then completed will still regenerate as due at 9:00 AM tomorrow. Bulk snooze uses two-tier priority filtering — see [Behavioral Model](#behavioral-model).

### Updating recurrence rules

Updating `rrule` also re-derives `anchor_*` fields and may recompute `due_at`. When logging this for undo, include all derived fields in `fieldsChanged` so undo restores the complete prior state:

```ts
const fieldsChanged = ['rrule', 'anchor_time', 'anchor_dow', 'anchor_dom', 'due_at']
```

### Undo system

Functions from `@/core/undo`:

```ts
logAction(
  userId: number,
  action: UndoAction, // 'done' | 'undone' | 'snooze' | 'edit' | 'delete' | 'create' | 'restore' | 'bulk_done' | 'bulk_snooze' | 'bulk_edit' | 'bulk_delete'
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
): number
```

- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot` (use this for all mutation logging)
- `executeUndo(userId)` — restores the task to `before_state` from the most recent undoable action
- `executeRedo(userId)` — re-applies `after_state` from the most recent undone action

Undo history is per-user and works as a stack (last action undone first).

**Special case**: Undoing a task creation soft-deletes the task (sets `deleted_at`) rather than permanently deleting it.

### Task access

`canUserAccessTask(userId, task)` from `@/core/tasks` — returns `true` if the user owns the task or it's in a shared project. Use this in route handlers that need to verify access.

### Purge modules

Automatic data cleanup modules run on a schedule via cron jobs started in `src/instrumentation.ts`:

- `src/core/undo/purge.ts` — prunes old undo log entries
- `src/core/stats/purge.ts` — cleans up stale stats data
- `src/core/tasks/purge-completions.ts` — removes old task completion records
- `src/core/tasks/purge-trash.ts` — permanently deletes tasks that have been in trash past the retention period

## Conventions

### Naming

- Import alias: `@/` maps to `src/`
- React components: PascalCase (`CreateTaskPanel.tsx`, `TaskRow.tsx`)
- Other source files: kebab-case (`api-response.ts`, `critical-alerts.ts`)
- Types/interfaces: PascalCase (`Task`, `AuthUser`, `UpdateTaskOptions`)
- DB columns: snake_case (`due_at`, `created_at`, `anchor_dow`)
- API fields: snake_case (`project_id`, `original_due_at`)

### Code policies

- Store all dates as UTC in the database. API responses and UI code must convert dates to the user's timezone (available as `AuthUser.timezone`).
- Update endpoints use PATCH, not PUT — the handler updates only fields present in the request body.
- When you need a UI primitive not already in `src/components/ui/`, install it with `npx shadcn@latest add <component>`. This generates the file in `src/components/ui/`.
- **Never suppress lint errors or warnings** (e.g., `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`) without explicit approval from the user. Fix the root cause instead. If a fix is genuinely impossible, ask the user before adding any suppression comment.
- **No brittle fixes or tolerances.** Don't add buffers, timeouts, or tolerances to work around symptoms. If something seems like a race condition or timing issue, understand the actual requirement first. Code should be deterministic and precise, not held together by tolerances and timeouts. For example, if a test fails intermittently, find the ordering or state bug rather than adding `setTimeout` or retry loops.
- **Document unintuitive or complex code within the same code file.** Non-obvious behavior (e.g., UX flows, UI layouts, backend behaviors) can be hard to infer from code at a glance. Add a comment block explaining what the behavior is and why, so future readers don't have to reverse-engineer it. Do this as you build or modify features — when in doubt, err on the side of documenting.
- ESLint warns on: `max-lines-per-function: 150` (excluding blank lines and comments), `complexity: 20`, `max-depth: 5`, `max-nested-callbacks: 4`.
- When modifying an existing endpoint that uses `getAuthUser`, you do not need to migrate it to `requireAuth` unless explicitly asked.

### Tooling

- **Pre-commit hook**: `lint-staged` runs Prettier and ESLint on staged files before every commit. If a commit is rejected, fix the issues and retry — do not bypass with `--no-verify`. Common failures: Prettier formatting (fix with `npm run format`), ESLint errors (fix the code, do not suppress).
- **Formatting**: Prettier (semi: false, singleQuote: true, printWidth: 100, Tailwind plugin). Run `npm run format` to format all files.

## API Reference

### Route handler pattern

Preferred pattern using `requireAuth` (adapted from `src/app/api/tasks/[id]/route.ts`, which still uses `getAuthUser`):

```ts
import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { updateTask } from '@/core/tasks'
import { validateTaskUpdate } from '@/core/validation'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params // Next.js 16 requires await
    const input = validateTaskUpdate(await request.json())
    const { task, fieldsChanged, description } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId: parseInt(id),
      input,
    })
    return success({
      ...formatTaskResponse(task),
      fields_changed: fieldsChanged,
      description,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'PATCH /api/tasks/:id error:', err)
    return handleError(err)
  }
}
```

Most existing handlers use `getAuthUser` with a manual null check (predating `requireAuth`). Both patterns are valid; `requireAuth` is preferred for new code. All handlers should log errors before calling `handleError()`.

Note: `updateTask()` handles its own transaction and undo logging internally.

### New endpoint checklist

Follow the pattern above, and verify:

- [ ] Use `requireAuth(request)` (preferred) or `getAuthUser(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with validation functions from `@/core/validation` (`validateTaskCreate`, `validateTaskUpdate`, etc. — these call Zod `.parse()` internally)
- [ ] Wrap in try/catch: `AuthError` → `unauthorized()`, `ZodError` → `handleZodError()`, else → `handleError()`
- [ ] Use PATCH for updates (not PUT)
- [ ] If you created a new core mutation function, ensure it uses `withTransaction()` and calls `logAction()` with before/after snapshots (see [Critical Requirements](#critical-requirements))
- [ ] Format task responses with `formatTaskResponse()` from `@/lib/format-task`
- [ ] Return using response helpers: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()` — success format: `{ data: ... }`, error format: `{ error, code, details? }`
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing

## Development and Testing

### When to run which tests

If a change spans multiple rows in this table, combine the test suites from all matching rows. If a change affects what the user sees on screen (even via a shared utility like `format-task.ts`), treat it as a UI change.

| Change type                                   | What to run                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Every change (always run)                     | The quick check                                                                                    |
| API routes, core logic, validation, auth      | Quick check + `npm run test:integration`                                                           |
| AI prompts, enrichment logic, AI behavior     | Quick check + `npm run test:quality` (both layers) — see [AI quality testing](#ai-quality-testing) |
| UI components, hooks, styles, client behavior | Quick check + `npm run test:e2e` + **deploy to dev + [browser verification](#ui-verification)**    |
| Refactoring / code reorganization             | All test suites                                                                                    |
| Production deploy                             | All test suites (see [Deployment](#deployment) section)                                            |

During rapid iteration within a UI verification loop, the quick check between deploys is sufficient; the full checklist applies to the final version before reporting results.

E2E tests (run locally) and browser verification (run against dev) are complementary — both are required for UI changes.

Run a single test: `npx vitest tests/behavioral/some-spec.test.ts --run`
Run a single E2E test: `npx playwright test tests/e2e/some.spec.ts`

### AI quality testing

**Production has essentially no feedback loop for AI quality.** There is no user rating system, no A/B testing, no way to know if the AI is producing good results in the field. Quality testing IS the quality bar — the AI will only perform as well as our tests prove it can. This makes two things critical:

1. **How extensive and realistic the quality test scenarios are** — scenarios must cover the full range of real-world inputs: dictation artifacts, typos, edge cases, ambiguous phrasing, colloquial language, and every field combination. If a scenario isn't tested, assume it doesn't work.
2. **How well the AI holds up under that testing** — every scenario must be evaluated in Layer 2, and any score below 6 means the prompt needs iteration. Do not ship prompt changes that degrade quality on existing scenarios.

**`test:quality` is a two-step process.** Running `npm run test:quality` is only Layer 1 (generation + structural validation). You must then perform Layer 2 (quality evaluation) by following the instructions printed to stdout. Do not report quality tests as complete until Layer 2 is done. See `docs/AI.md` for details.

**Before modifying AI prompts**, dump and review the fully rendered prompts. The prompt source in `src/core/ai/prompts.ts` uses shared sections and template literals that are hard to read in isolation — `dump-prompts` assembles them into the final text the AI actually sees, which is the only reliable way to review them.

```bash
npm run dump-prompts                              # All 3 prompts (templates only) → .tmp/prompts.txt
npm run dump-prompts -- --feature enrichment      # Just the enrichment prompt
npm run dump-prompts -- --feature insights         # Just the insights prompt
npm run dump-prompts -- --feature whats_next       # Just the what's next prompt
npm run dump-prompts -- --scenario insights-medium-list  # Render with a test scenario's task data
npm run dump-prompts -- --list                     # List available scenarios
```

**When modifying AI prompts or enrichment logic:**

- Dump and review the rendered prompt first — check for contradictions, stale rules, and redundancy
- Run both Layer 1 and Layer 2 on ALL scenarios (not just new ones)
- If any scenario regresses, fix the prompt before proceeding
- When adding new behavior, add scenarios that test it — untested behavior is unverified behavior
- Scenarios live in `tests/quality/scenarios/` organized by category

### Pre-existing test failures

If a test fails that is unrelated to your current change, report it to the user before proceeding. Do not silently skip failing tests. After reporting a pre-existing failure, you may continue with your current work unless instructed otherwise. Do not modify the failing test to make it pass.

### UI verification

**Any UI change must be deployed to dev and verified in the browser before reporting the work as done.** Do not tell the user the work is done, suggest they verify, or ask if they'd like you to deploy — you deploy it, you verify it, you report what you found.

During iterative UI verification deploys to dev, committing between each deploy is not required. Commit once the final verified version is ready, then re-deploy from the clean commit.

**Dev login credentials** are in `.secrets` at the project root. Read that file before logging in via Playwright.

**UI change is not done until every box is checked:**

- [ ] Quick check passes
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Deployed to dev via `./scripts/deploy.sh dev`
- [ ] Playwright: screenshots at desktop (1280x800+) and mobile (375x812) viewports (save to `.tmp/`)
- [ ] Playwright: no console errors/warnings, no failed network requests
- [ ] Interactive flows tested with Playwright (if applicable — clicks, form submissions, state changes)
- [ ] Fixes applied and re-deployed if anything looked wrong
- [ ] Dev link shared with results: https://tasks-dev.tk11.mcnitt.io

Backend/logic-only changes with no UI touchpoint do not need browser verification — passing tests are sufficient.

### Behavioral tests

Location: `tests/behavioral/`

Behavioral tests exercise core logic with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Test files run sequentially (not in parallel) because they share a single database.

Helper: `tests/helpers/setup.ts`

### Integration tests

Location: `tests/integration/`

Integration tests send real HTTP requests to a running `next start` server (the production build). The `globalSetup.ts` builds the app and starts the server automatically. Uses hardcoded test tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this calls `POST /api/test/reset`, which is only available when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

### E2E tests

Location: `tests/e2e/`

Playwright with headless Chromium. Uses separate DB (`data/test-e2e.db`). The `authenticatedPage` fixture provides a pre-logged-in browser page by logging in via the real login form.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

### Test data seeding

`scripts/seed-test.ts` seeds deterministic test data for integration and E2E tests. Separately, `npm run db:seed` (which runs `scripts/seed.ts`) seeds the development database with initial users and projects.

### Test naming conventions

Behavioral tests use 2-letter prefixes for feature areas (`bo-` bulk ops, `sn-` snooze, `ur-` undo/redo, `rd-` recurrence, `di-` data integrity). Utility-focused tests use descriptive names without prefixes.

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

### Dirty state navigation warning

The task detail page (and any page with QuickActionPanel) has a `beforeunload` handler that triggers a browser "Leave site?" confirmation dialog when there are unsaved changes. When using Playwright for browser testing:

1. Reset dirty state first: Click "Reset" or "Cancel" before navigating away
2. Or handle the dialog: Use `mcp__playwright__browser_handle_dialog` with `accept: true` to dismiss the dialog and proceed

## Environments and Deployment

|         | Production                  | Development                     | Dev2                             | Local          |
| ------- | --------------------------- | ------------------------------- | -------------------------------- | -------------- |
| URL     | tasks.tk11.mcnitt.io        | tasks-dev.tk11.mcnitt.io        | tasks-dev2.tk11.mcnitt.io        | localhost:3000 |
| Port    | 3100                        | 3101                            | 3102                             | 3000           |
| Service | opentask.service            | opentask-dev.service            | opentask-dev2.service            | —              |
| DB Path | /opt/opentask/data/tasks.db | /opt/opentask-dev/data/tasks.db | /opt/opentask-dev2/data/tasks.db | data/tasks.db  |
| Server  | tk11.mcnitt.io              | tk11.mcnitt.io                  | tk11.mcnitt.io                   | —              |

Remote instances run behind Caddy reverse proxy on Ubuntu 24.04. Server: `ssh admin@tk11.mcnitt.io`.

**Git remote**: Forgejo at `git.tk11.mcnitt.io` (use `tea` CLI, not `gh`).

### Deployment

Commit all changes before deploying — the rollback strategy depends on checking out a previous commit. If there are uncommitted changes and you need to deploy, ask the user to confirm a commit first. This overrides the general "only commit when explicitly instructed" rule for deployment safety. Exception: iterative dev deploys during UI verification do not require committing between each deploy — see [UI verification](#ui-verification).

**Remote deployment (dev or prod):**

```bash
# 1. Verify (full suite for production; quick check sufficient for iterative dev deploys)
npm run type-check && npm run lint && npm test && npm run test:integration && npm run test:e2e

# 2. Deploy (requires explicit target — no default)
./scripts/deploy.sh dev   # Deploy to development
./scripts/deploy.sh prod  # Deploy to production
```

**What `deploy.sh` does:** (1) builds locally, (2) rsyncs the standalone bundle to the server, (3) fetches a Linux-native `better-sqlite3` binary via `prebuild-install`, and (4) restarts the systemd service. The database is never touched by deploys — schema migrations run on app startup.

**Server debugging:** `ssh admin@tk11.mcnitt.io` then `journalctl -u opentask-dev -f` (or `opentask` for prod) to tail logs.

**Rollback:** Prefer `git revert HEAD` (creates a new commit, preserves history). Only use `git checkout <sha>` if you need to roll back multiple commits, and create a new branch from that point before deploying. Then re-deploy with `./scripts/deploy.sh <target>`.

**Database inspection:** `sqlite3 data/tasks.db` (local) or `ssh admin@tk11.mcnitt.io` then `sqlite3 /opt/opentask/data/tasks.db` (prod) / `sqlite3 /opt/opentask-dev/data/tasks.db` (dev).

**First-time server setup:** The deploy script assumes the systemd service already exists. For a new environment, create a systemd unit file on the server (use `opentask-dev.service` as a template) and run `systemctl enable` before the first deploy.
