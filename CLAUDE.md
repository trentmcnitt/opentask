# CLAUDE.md

## Commands

```bash
npm run dev              # Local dev server (port 3000)
npm run build            # Production build (Next.js standalone)
npm run start            # Start production server (for local testing)
npm run lint             # ESLint
npm run type-check       # tsc --noEmit
npm test                 # Behavioral tests (vitest, no HTTP/UI)
npm run test:integration # Integration tests (HTTP against built server)
npm run test:e2e         # Playwright E2E tests (headless)
npm run test:e2e:ui      # Playwright with UI
npm run test:watch       # Vitest watch mode
npm run db:seed          # Seed database with initial users and projects
```

### Verification

After any code change, run:
```bash
npm run type-check && npm run lint && npm test
```

When to run additional tests:
- After API route changes: also run `npm run test:integration`
- After UI changes: also run `npm run test:e2e`
- Before deployment: run all three test suites

Run a single test file: `npx vitest tests/behavioral/some-spec.test.ts --run`

Run a single E2E file: `npx playwright test tests/e2e/some.spec.ts`

## Stack

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA with iOS optimization.

## Conventions

### Naming

- Import alias: `@/` maps to `src/`
- Source files: kebab-case (`add-task-form.tsx`, `critical-alerts.ts`)
- Types/interfaces: PascalCase (`Task`, `AuthUser`, `UpdateTaskInput`)
- DB columns: snake_case (`due_at`, `created_at`, `anchor_dow`)
- API fields: snake_case (`project_id`, `snoozed_from`)

### Coding Rules

- Store all dates as UTC in the database. API responses and UI code must convert to user timezone (from `AuthUser.timezone`).
- All mutation endpoints use PATCH, not PUT — the handler updates only fields present in the request body.
- `priority` values: 0=unset, 1=low, 2=medium, 3=high, 4=urgent

### Critical Requirements

- **Undo logging**: Every task mutation must call `logAction()` from `@/core/undo` before returning. This includes create, update, delete, complete, snooze, and archive operations.
- **Transactions**: Multi-step DB mutations must use `withTransaction()` from `@/core/db` to prevent data corruption on partial failure. Use when: updating a task AND writing to undo_log, modifying multiple tasks, or creating a task AND adding a completion record.
- **Auth security**: If an Authorization header is present but invalid, return 401 immediately — never fall back to session auth.

**Exception**: "Empty Trash" performs permanent deletion and cannot be undone. This is the only non-undoable mutation and requires explicit user confirmation.

## Architecture

See `docs/SPEC.md` for product requirements and feature scope.

### Source Layout

- `src/core/` — Business logic (no UI): auth, db, tasks, recurrence, undo, validation, notifications, review
- `src/components/` — React components (TaskList, TaskRow, TaskDetail, QuickAdd, etc.)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode`, `useGroupSort`)
- `src/app/api/` — REST API routes with dual auth (session cookies + Bearer tokens)
- `src/app/` — Pages (App Router): dashboard, login, task detail, projects, settings, history, archive, trash
- `src/lib/` — Utilities: `api-response.ts`, `format-task.ts`, `format-rrule.ts`, `toast.ts`, `utils.ts`
- `src/types/` — Domain types (`index.ts`) and API route types (`api.ts`)
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs

### Database

- **Singleton**: Access via `getDb()` from `@/core/db`
- **Schema**: `src/core/db/schema.sql` — applied idempotently on first connection
- **Config**: `OPENTASK_DB_PATH` env var (default: `data/tasks.db`)
- **Mode**: WAL (write-ahead logging), 5s busy timeout, foreign keys enforced
- **Operations**: All synchronous (better-sqlite3)
- **JSON columns**: Labels and undo snapshots stored as TEXT; parse/serialize in application code

**Transaction requirement**: Wrap multi-step mutations in `withTransaction()`. Without it, if an error occurs mid-operation, some changes may be written while others are not.

### Auth

Dual authentication checked in order:

| Auth Present | Valid? | Action |
|--------------|--------|--------|
| Bearer token | Yes | Use token auth |
| Bearer token | No | Return 401 (never fall back) |
| None | — | Check session cookie |
| Session cookie | Yes | Use session auth |
| Session cookie | No | Return 401 |

**Functions** from `@/core/auth`:
- `requireAuth(request)` — Returns `AuthUser` or responds with 401. Use for protected endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when auth is optional.

Both return `AuthUser { id, email, name, timezone }`.

### API Patterns

Typical route handler pattern:

```ts
import { requireAuth } from '@/core/auth'
import { success, handleZodError, internalError } from '@/lib/api-response'
import { UpdateTaskSchema } from '@/types/api'
import { updateTask } from '@/core/tasks'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params  // Next.js 16 requires await
    const body = UpdateTaskSchema.parse(await request.json())
    const result = updateTask(user.id, user.timezone, Number(id), body)
    return success(result)
  } catch (error) {
    return handleZodError(error) ?? internalError(error)
  }
}
```

- Response helpers from `@/lib/api-response`: `success(data)`, `badRequest()`, `unauthorized()`, `notFound()`, `internalError()`
- Success format: `{ data: ... }` — Error format: `{ error, code, details? }`
- Validate inputs at the API boundary with Zod schemas from `@/types/api`

#### New Endpoint Checklist

- [ ] Use `requireAuth(request)` or `getAuthUser(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with Zod schema
- [ ] Wrap in try/catch with `handleZodError()` and `internalError()`
- [ ] Use PATCH for updates (not PUT)
- [ ] If mutation, call `logAction()` before returning
- [ ] If multi-step mutation, wrap in `withTransaction()`
- [ ] Return using response helpers (`success()`, `badRequest()`, etc.)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing

### Recurrence

- RFC 5545 RRULE strings (e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`
- Anchor fields (`anchor_time`, `anchor_dow`, `anchor_dom`) preserve the intended time-of-day across timezone and DST transitions (e.g., a task due at 9 AM stays at 9 AM local time after a DST change)
- `computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement
- Recurring tasks advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- One-off (non-recurring) tasks: when completed, marked `done=1` and `archived_at` set to current time

**PATCH exception**: When `rrule` is updated, the server automatically re-derives `anchor_*` fields and may recompute `due_at`. This is the only case where updating one field triggers updates to others.

### Undo

Every mutation is logged to `undo_log` with a snapshot of only the changed fields.

- `logAction(userId, action, description, fieldsChanged, snapshots)` from `@/core/undo` — call before returning from mutation
- `executeUndo(userId)` — restores `before_state` from most recent undoable action
- `executeRedo(userId)` — replays `after_state` from most recent undone action

Undo history is per-user and works as a stack (last action undone first).

**Special case**: Undoing a task creation soft-deletes the task (sets `deleted_at`), not permanent deletion.

## Testing

Three test tiers with JSON results in `test-results/`:

### Behavioral Tests

Location: `tests/behavioral/`

Core logic tests with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Sequential execution.

Helper: `tests/helpers/setup.ts`

### Integration Tests

Location: `tests/integration/`

Real HTTP requests against `next start`. The `globalSetup.ts` builds the app and starts the server automatically. Uses hardcoded test tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this hits `POST /api/test/reset` which only functions when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

### E2E Tests

Location: `tests/e2e/`

Playwright with headless Chromium. Uses separate DB (`data/test-e2e.db`). The `authenticatedPage` fixture logs in via the real login form.

Run with `--headed` to see the browser.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

### Test Data Seeding

`scripts/seed-test.ts` provides deterministic test data seeding used by integration and E2E tests.

## Environments

Three deployment targets:

| Attribute | Production | Development | Local |
|-----------|------------|-------------|-------|
| URL | tasks.tk11.mcnitt.io | tasks-dev.tk11.mcnitt.io | localhost:3000 |
| Port | 3100 | 3101 | 3000 |
| Process | opentask.service | opentask-dev.service | `npm run dev` |
| DB Path | /opt/opentask/data/tasks.db | /opt/opentask-dev/data/tasks.db | data/tasks.db |
| Host | tk11.mcnitt.io | tk11.mcnitt.io | localhost |

Both remote instances run behind Caddy reverse proxy on Ubuntu 24.04.

### Deployment

**Local development:**
```bash
npm run dev    # Starts on localhost:3000
```

**Remote deployment (dev or prod):**
```bash
# 1. Run tests locally
npm run type-check && npm run lint && npm test

# 2. Commit and push to git
git push origin main

# 3. Deploy (pulls from git and builds on server)
./scripts/deploy.sh dev   # Deploy to development
./scripts/deploy.sh prod  # Deploy to production
```

**What the deploy script does:**
1. SSHs to the server
2. Pulls latest code from git (`origin/main`)
3. Runs `npm ci` and `npm run build` on the server
4. Sets up static files symlink (Next.js standalone quirk)
5. Restarts the systemd service

Building on the server avoids cross-platform issues with native modules like `better-sqlite3`.

**Rollback:** `git revert` the commit, push, and re-deploy.

Git remote: Forgejo at `git.tk11.mcnitt.io` (use `tea` CLI for repo operations, not `gh`).
