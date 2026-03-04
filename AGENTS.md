# OpenTask

Self-hosted task management PWA. This is the authoritative reference for contributing to this codebase. Canonical filename: `AGENTS.md` (symlinked as `CLAUDE.md` for Claude Code compatibility).

**Start here:** [Critical Requirements](#critical-requirements) (data-loss prevention), [Commands](#commands) (build/test), [Route Handler Guide](#route-handler-guide) (API patterns), [Development and Testing](#development-and-testing) (what to run when). Reference sections (task model, due dates) are at the end — consult them when working on related features.

See also: `README.md` (project overview), `CONTRIBUTING.md` (quickstart), `TASKS.md` (backlog). Environment-specific details (server addresses, deploy scripts, credentials) are in `CLAUDE.local.md` (gitignored).

## Architecture

Next.js 16 (App Router) + React 19 + React Compiler + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA optimized for iOS. Basic offline support: `public/sw.js` caches the app shell so navigation works offline, but there is no offline data access or mutation queuing. Uses Next.js standalone output mode for deployment. A native iOS companion app (`ios/`) wraps the PWA in a WKWebView and adds APNs push notifications.

Additional docs: `docs/SPEC.md` (product requirements), `docs/ROADMAP.md` (planned features), `docs/AUTOMATION.md` (external API integration), `DEV_LOG.md` (design decisions and narrative context), `docs/NOTIFICATIONS.md` (push architecture), `docs/IOS-DEV-LOG.md` (iOS history), `docs/openapi.yaml` (REST API schema), `docs/AI.md` (AI architecture and quality testing), `docs/TASK-MODEL.md` (task model reference), `docs/DESIGN.md` (design philosophy).

### Documentation site

The public docs site lives in a separate repo (`opentask-docs`, typically at `~/working_dir/opentask-docs`) (VitePress, deployed to `opentask.mcnitt.io/docs/`). When you change features, API behavior, or configuration in this repo, the docs site may need a corresponding update. Key sync points:

| Change in this repo                          | Update in opentask-docs                           |
| -------------------------------------------- | ------------------------------------------------- |
| API routes or response format                | `openapi.json` (convert from `docs/openapi.yaml`) |
| AI features or provider options              | `setup/ai.md`, `setup/configuration.md`           |
| Environment variables                        | `setup/configuration.md`                          |
| Core behavior (snooze, priority, recurrence) | `concepts/` pages                                 |
| New feature or major change                  | `overview.md`                                     |

See `~/working_dir/opentask-docs/CLAUDE.md` for build/deploy instructions and full sync details.

### Source layout

- `src/core/` — Business logic (no UI): auth, db, errors, projects, tasks, recurrence, undo, validation, notifications, webhooks, review, stats, ai, activity, export
- `src/components/` — React components (see directory for full inventory)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode.ts`, `useGroupSort.ts`, `useTimezone.ts`, `useKeyboardNavigation.ts`, etc.)
- `src/app/api/` — REST API routes with three auth methods (Bearer tokens + proxy headers + session cookies)
- `src/app/` — Pages (App Router): root (`/`), login, tasks/[id], settings, history, archive, trash
- `src/lib/` — Utilities (`api-response.ts`, `format-task.ts`, `format-date.ts`, `format-rrule.ts`, `logger.ts`, `priority.ts`, `toast.ts`, `utils.ts`, etc.)
- Real-time sync via Server-Sent Events (pushes task changes to open browser tabs): `src/app/api/sync/stream/`, `src/lib/sync-events.ts`, `src/hooks/useSyncStream.ts`
- `src/types/` — Domain types (`index.ts`), API route types (`api.ts`), NextAuth augmentation (`next-auth.d.ts`), Web Speech API types (`speech-recognition.d.ts`)
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs
- `ios/` — Native iOS companion app (see [iOS App](#ios-app-ios) section)
- `assets/` — Source logo and branding files (Pixelmator sources + exported PNGs). After updating source files in `assets/`, copy exports to `public/`.

### UI vocabulary

| Term        | Component                                 | Description                                                                 |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Top bar     | `src/components/Header.tsx`               | Fixed header with snooze button, task count, and navigation                 |
| Quick panel | `src/components/QuickActionPanel.tsx`     | Grid of snooze/priority buttons used in task detail and the dashboard modal |
| Action bar  | `src/components/SelectionActionSheet.tsx` | Floating black bar with Done/Details/More buttons shown during selection    |

### Database

- **Singleton**: Access via `getDb()` from `@/core/db`
- **Schema**: `src/core/db/schema.sql` — `getDb()` applies this on first call (safe to re-run) using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
- **Config**: `OPENTASK_DB_PATH` env var (default: `data/tasks.db`). See `.env.example` for all env vars.
- **Mode**: WAL (write-ahead logging) for concurrent read performance, 5-second busy timeout (waits for locks to release before failing), foreign keys enforced
- **Operations**: All synchronous (better-sqlite3)
- **JSON columns**: Labels and undo snapshots are stored as TEXT; parse/serialize in application code

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

To test schema changes from scratch, delete `data/tasks.db` to force a full rebuild. To test the migration path, keep an existing database and restart the app — `runMigrations()` applies the change idempotently.

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
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when you need to customize the error response (e.g., returning a different message or status code). Most existing route handlers use this with a manual null check.

Do not migrate existing `getAuthUser` endpoints to `requireAuth` unless explicitly asked.

`AuthUser` shape: `{ id, email, name, timezone, default_grouping: 'time' | 'project' | 'unified', is_demo: boolean }`.

**Login is username-based.** The login form accepts a username (the `name` column, case-insensitive). Email also works as a login identifier for convenience, but the primary interface is username.

NextAuth is configured in `src/app/api/auth/[...nextauth]/auth.ts` (credentials provider, JWT sessions, custom callbacks).

### Security

- **API tokens**: Stored as SHA-256 hashes. The `token` column in `api_tokens` holds the hash; `token_preview` stores the last 8 chars of the raw token for UI display. The raw token is displayed once when generated and cannot be retrieved afterward.
- **Login rate limiting**: In-memory; 5 failures per username in 15 minutes trigger a lockout with exponential backoff (30s, 60s, 120s...).
- **Security headers**: Set in `next.config.ts` and your reverse proxy config: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **JWT sessions**: `maxAge` set to 7 days (NextAuth default is 30 days).

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
npx tsx scripts/create-user.ts <username> <password> [email] [timezone]  # Create user (no npm script wrapper)
```

**Quick check**: `npm run type-check && npm run lint && npm test`

## Critical Requirements

These rules prevent data-loss bugs and security issues. Violating the atomic mutation rule can cause data loss; failing to reject invalid tokens can create security bypasses.

### Every mutation must be atomic and logged for undo

Every task mutation must be logged for undo, and the mutation + log write must be atomic. Core mutation functions in `src/core/tasks/` call both `logAction()` and `withTransaction()` internally. Route handlers call the core mutation function directly — they do not call `logAction()` or `withTransaction()` themselves.

If you create a **new core mutation function**, follow the existing pattern:

```ts
withTransaction((db) => {
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPriority, taskId)
  logAction(user.id, 'edit', 'Updated priority', ['priority'], [snapshot])
})
```

Use `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` to build the before/after snapshot. The `completionId` parameter is only needed when completing a recurring task — it links the `completions` row to the undo snapshot (see `markDone()` in `src/core/tasks/mark-done.ts` for the pattern).

For task creation, pass `{ id: taskId }` as `beforeTask` (there is no full before-state). On undo, the system soft-deletes the task (since there is no before-state to restore). See `createTask()` in `src/core/tasks/create.ts` for the pattern.

For bulk operations, use the corresponding `bulk_*` action type (e.g., `bulk_done`, `bulk_snooze`) and pass an array of snapshots — one per affected task. See `src/core/tasks/bulk.ts` for the pattern.

### All deletions must be soft deletes

All task deletions are soft-deletes (set `deleted_at`). The only hard-delete operation is "Empty Trash," which permanently deletes data, cannot be undone, and must require explicit user confirmation.

```ts
db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, taskId)
```

These undo and soft-delete requirements apply to task mutations specifically. Project and user mutations do not use the undo system.

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

- **Pre-commit hook**: `lint-staged` runs Prettier and ESLint on staged files before every commit. If a commit is rejected, fix the issues and retry — do not bypass with `--no-verify`. Common failures: Prettier formatting (fix with `npm run format`), ESLint errors (fix the code, do not suppress).
- **Node version**: Pinned in `.node-version` at the project root.
- **Formatting**: Prettier (semi: false, singleQuote: true, printWidth: 100, Tailwind plugin). Run `npm run format` to format all files.

## Route Handler Guide

### Route handler pattern

Wrap all route handlers with `withLogging()` from `@/lib/with-logging`, which logs every request with method, path, status, duration, and auth type. Log level varies by status: 5xx → `error`, 4xx → `warn`, 2xx → `info`. Uses the `http` namespace.

Preferred pattern for new route handlers:

```ts
import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
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
})
```

Log unexpected errors in the catch-all before calling `handleError()` — expected errors like `AuthError` and `ZodError` don't need explicit logging.

Note: `updateTask()` handles its own transaction and undo logging internally.

### New route handler checklist

Follow the pattern above, and verify:

- [ ] Use `requireAuth(request)` (preferred for new handlers) or `getAuthUser(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with validation functions from `@/core/validation` (`validateTaskCreate`, `validateTaskUpdate`, etc. — these call Zod `.parse()` internally)
- [ ] Wrap in try/catch: `AuthError` → `unauthorized()`, `ZodError` → `handleZodError()`, else → `handleError()`. Core functions may also throw `NotFoundError`, `ForbiddenError`, or `ValidationError` from `@/core/errors` — `handleError()` handles these automatically via the `AppError` base class.
- [ ] Use PATCH for updates (not PUT)
- [ ] If you created a new core mutation function, ensure it uses `withTransaction()` and calls `logAction()` with before/after snapshots (see [Critical Requirements](#critical-requirements))
- [ ] Format task responses with `formatTaskResponse()` from `@/lib/format-task`
- [ ] Return using response helpers: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()` — success format: `{ data: ... }`, error format: `{ error, code, details? }`
- [ ] Wrap handlers with `withLogging()` from `@/lib/with-logging` (use named function expression for stack traces)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing
- [ ] Update `docs/openapi.yaml` if this adds or changes a public API endpoint

## Development and Testing

### When to run which tests

If a change spans multiple rows in this table, combine the test suites from all matching rows. If a change affects what the user sees on screen (even via a shared utility like `format-task.ts`), treat it as a UI change.

| Change type                                   | What to run                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Every change (always run)                     | The quick check (`npm run type-check && npm run lint && npm test`)                                                                  |
| API routes, core logic, validation, auth      | Quick check + `npm run test:integration`                                                                                            |
| AI prompts, enrichment logic, AI behavior     | Quick check + `npm run test:quality` (Layer 1; then perform Layer 2 — see [AI quality testing](#ai-quality-testing))                |
| UI components, hooks, styles, client behavior | Quick check + `npm run test:e2e` + **deploy to dev + [browser verification](#ui-verification)**                                     |
| iOS app (Swift, project.yml)                  | Build with `xcodegen` + `xcodebuild`. Manual testing on device. No automated test suite.                                            |
| Refactoring / code reorganization             | All test suites                                                                                                                     |
| Production deploy                             | All test suites relevant to changes being deployed (always: quick check + integration + E2E; add `test:quality` if AI code changed) |

During rapid iteration (deploy, verify in browser, fix, re-deploy), the quick check between deploys is sufficient. Run the full checklist on the final version before reporting results.

E2E tests (run locally) and browser verification (run against dev) are complementary — both are required for UI changes.

Run a single test: `npx vitest tests/behavioral/some-spec.test.ts --run`
Run a single E2E test: `npx playwright test tests/e2e/some.spec.ts`

### AI quality testing

AI quality testing has two layers:

1. **Layer 1** — Automated structural validation (valid JSON, required fields, type checks). Run with `npm run test:quality`.
2. **Layer 2** — LLM-as-judge semantic evaluation using `tests/quality/validator-prompt.md` (scoring 0-10, pass >= 6). Perform manually by following the instructions printed by Layer 1.

Do not report quality tests as complete until both layers pass.

Production has no feedback loop for AI quality — quality testing **is** the quality bar. If a scenario isn't tested, assume it doesn't work. Do not ship prompt changes that degrade quality on existing scenarios.

Always dump and review the rendered prompt before and after any AI prompt change: `npm run dump-prompts -- --feature <feature>`. See `docs/AI.md` § Quality Testing for the full workflow, all `dump-prompts` flags, and targeted re-run commands.

Scenarios live in `tests/quality/scenarios/` organized by category.

### Pre-existing test failures

If a test fails that is unrelated to your current change, report it to the user before proceeding. Do not silently skip failing tests. After reporting a pre-existing failure, you may continue with your current work unless instructed otherwise — pre-existing failures do not block checklists or workflows. Do not modify the failing test to make it pass.

### UI verification

**Any UI change must be deployed to dev and verified in the browser before reporting the work as done.** Do not tell the user the work is done, suggest they verify, or ask if they'd like you to deploy — you deploy it, you verify it, you report what you found.

During iterative UI verification deploys to dev, committing between each deploy is not required. Commit once the final verified version is ready, then re-deploy from the clean commit.

**Dev login credentials** are in `.secrets` at the project root. Read that file before logging in via Playwright.

**A UI change is not done until every box is checked.** Note any pre-existing test failures in your results — they do not block this checklist.

- [ ] Quick check passes
- [ ] E2E tests pass (`npm run test:e2e`)
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

### Integration tests

Location: `tests/integration/`

Integration tests send real HTTP requests to a running `next start` server (the production build). The global setup script (`globalSetup.ts`) builds the app and starts the server automatically. These tests authenticate using test-only tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this calls `POST /api/test/reset`, which is only available when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

### E2E tests

Location: `tests/e2e/`

Playwright with headless Chromium. Uses separate DB (`data/test-e2e.db`). The `authenticatedPage` fixture provides a pre-logged-in browser page by logging in via the real login form.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

If navigating away triggers a `beforeunload` dialog, either reset dirty state first (click Reset/Cancel) or use `mcp__playwright__browser_handle_dialog` with `accept: true` to dismiss it.

### Test data seeding

`scripts/seed-test.ts` seeds deterministic test data for integration and E2E tests. For development (not testing), `npm run db:seed` (which runs `scripts/seed.ts`) seeds the development database with initial users and projects.

### Test naming conventions

Behavioral tests use 2-letter prefixes for feature areas (`bo-` bulk ops, `sn-` snooze, `ur-` undo/redo, `rd-` recurrence, `di-` data integrity, `ai-` AI features). Utility-focused tests use descriptive names without prefixes.

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

## Deployment

**Local development:** `npm run dev` starts a hot-reloading server on port 3000.

**Production deployment:** OpenTask uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory. Deploy the built output however you prefer — systemd service, Docker, etc. A `Dockerfile` and `docker-compose.yml` are provided; a GitHub Actions workflow (`.github/workflows/docker-publish.yml`) publishes images to GHCR on version tags. Schema migrations run automatically on app startup.

**Commit policy for deployments** (overrides the global "only commit when explicitly instructed" rule):

- **Production deploy**: Commit all changes first — rollback depends on checking out a previous commit
- **Iterative dev deploys** (during UI verification): Commits not required between deploys
- **Final dev deploy** (after verification): Commit the verified version, then re-deploy from the clean commit
- If there are uncommitted changes and you need to deploy, ask the user to confirm a commit first

**Rollback:** `git revert HEAD`, then re-deploy. Database migrations are not rolled back — additive schema changes remain in place and are harmless. Destructive migrations (rare) may need manual SQL. Only use `git checkout <sha>` if you need to roll back multiple commits.

See `CLAUDE.local.md` (gitignored) for environment-specific deployment details (server addresses, service names, deploy scripts, database inspection, etc.).

## Task Model & Due Dates

See `docs/TASK-MODEL.md` for the complete task model reference: priority values, recurrence, completion behavior, snooze semantics, undo system API, and task access control.

**Due Date Philosophy (critical for AI work):** Due dates for P0-2 tasks are reminders, not deadlines. P3 is a deadline. P4 (Urgent) is a hard deadline and is excluded from bulk snooze. See `docs/TASK-MODEL.md` for full details and implications for code/AI.

**Undo system:** See [Critical Requirements](#every-mutation-must-be-atomic-and-logged-for-undo) for the atomic mutation pattern and API, or `docs/TASK-MODEL.md` for the full undo reference.

**Purge modules** run via cron jobs started in `src/instrumentation.ts`: `src/core/undo/purge.ts`, `src/core/stats/purge.ts`, `src/core/tasks/purge-completions.ts`, `src/core/tasks/purge-trash.ts`, `src/core/ai/purge.ts`, `src/core/webhooks/purge.ts`.

## Demo User

The demo account showcases OpenTask with curated portfolio-style tasks. Each user only sees their own data (filtered by `user_id`).

| Setting       | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Username      | `demo`                                                      |
| Password      | `demo` (shown on login page when `NEXT_PUBLIC_DEMO_MODE=1`) |
| Notifications | Disabled                                                    |
| Reset         | Every 4 hours (via cron)                                    |
| Projects      | Inbox, Try It, Personal, Client Work                        |

**Scripts:**

- `npm run db:seed-demo` — Create the demo user and tasks (run once)
- `npm run db:reset-demo` — Delete and re-create all demo data (cron)

## iOS App (`ios/`)

Native iOS companion app (SwiftUI, iOS 17+) wrapping the PWA in a WKWebView with APNs push notifications. Three targets: `OpenTask` (main app), `OpenTaskNotification` (content extension), `OpenTaskWatch` (watchOS companion). No automated tests — testing is manual. Build with `cd ios && xcodegen`.

**Server API endpoints used by the iOS app** (changes to these require manual iOS testing):

- `POST /api/push/apns/register`, `DELETE /api/push/apns/register` — device token registration
- `POST /api/notifications/actions` — done/snooze from notification actions
- `PATCH /api/tasks/{id}` — snooze to specific time (content extension)
- `POST /api/tasks/bulk/snooze-overdue` — bulk snooze from notification action
- `GET /api/user/preferences` — connection validation during setup

See `ios/CLAUDE.md` for full details: targets, shared code, contributing, notification mechanisms, and XcodeBuildMCP workarounds.
