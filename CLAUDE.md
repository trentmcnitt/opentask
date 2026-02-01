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
npm run test:coverage    # Vitest with coverage report
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
- Before deployment: see Deployment section for verification requirements

Run a single test file: `npx vitest tests/behavioral/some-spec.test.ts --run`

Run a single E2E file: `npx playwright test tests/e2e/some.spec.ts`

## Conventions

### Naming

- Import alias: `@/` maps to `src/`
- React components: PascalCase (`AddTaskForm.tsx`, `TaskRow.tsx`)
- Other source files: kebab-case (`api-response.ts`, `critical-alerts.ts`)
- Types/interfaces: PascalCase (`Task`, `AuthUser`, `UpdateTaskOptions`)
- DB columns: snake_case (`due_at`, `created_at`, `anchor_dow`)
- API fields: snake_case (`project_id`, `snoozed_from`)

### Coding Rules

- Store all dates as UTC in the database. API responses and UI code must convert to user timezone (from `AuthUser.timezone`).
- All mutation endpoints use PATCH, not PUT — the handler updates only fields present in the request body.
- `priority` values: 0=unset, 1=low, 2=medium, 3=high, 4=urgent

### Critical Requirements

- **Undo logging**: Every task mutation must call `logAction()` from `@/core/undo` after performing the mutation but before returning the response. This includes create, update, delete, complete, snooze, and archive operations. Use `createTaskSnapshot()` to build the before/after snapshots:

```ts
const snapshot = createTaskSnapshot(beforeTask, afterTask, ['priority'], completionId)
logAction(user.id, 'update', 'Updated priority', ['priority'], [snapshot])
```

- **Transactions**: Multi-step DB mutations (any operation with more than one DB write) must use `withTransaction()` from `@/core/db`. Since mutations also write to `undo_log` via `logAction()`, most mutations need this:

```ts
withTransaction((db) => {
  // perform the mutation
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPriority, taskId)
  // log for undo
  logAction(user.id, 'update', 'Updated priority', ['priority'], [snapshot])
})
```

- **Auth security**: If an Authorization header is present but invalid, return 401 — never fall back to session auth.

**Exception**: "Empty Trash" performs permanent deletion and cannot be undone. Any operation that permanently deletes data must require explicit user confirmation.

## Architecture

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA with iOS optimization. See `docs/SPEC.md` for product requirements and feature scope.

### Source Layout

- `src/core/` — Business logic (no UI): auth, db, tasks, recurrence, undo, validation, notifications, review
- `src/components/` — React components (TaskList, TaskRow, TaskDetail, QuickAdd, etc.)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.). Add new ones with `npx shadcn@latest add <component>`.
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
- **Schema changes**: Modify `src/core/db/schema.sql` directly. Only additive changes work idempotently (new tables, new columns with defaults). For destructive changes (rename/remove columns), add an `ALTER TABLE` migration in the `initializeSchema()` function in `src/core/db/index.ts`. Delete local `data/tasks.db` to test from scratch. Remote databases pick up schema changes on next app restart.

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
- `requireAuth(request)` — Returns `AuthUser` or throws (results in 401). Use for protected endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when auth is optional.

`AuthUser` shape: `{ id, email, name, timezone }`.

### API Patterns

Typical route handler pattern:

```ts
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { validateTaskUpdate } from '@/core/validation/task'
import { updateTask } from '@/core/tasks'
import { ZodError } from 'zod'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()
    const { id } = await context.params  // Next.js 16 requires await
    const body = validateTaskUpdate(await request.json())
    const result = updateTask(user.id, user.timezone, Number(id), body)
    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    return handleError(err)
  }
}
```

- Response helpers from `@/lib/api-response`: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()`
- Success format: `{ data: ... }` — Error format: `{ error, code, details? }`
- Validation functions in `@/core/validation/task.ts` (`validateTaskCreate`, `validateTaskUpdate`, etc.) — these call Zod `.parse()` internally

### New Endpoint Checklist

- [ ] Use `getAuthUser(request)` or `requireAuth(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with validation functions from `@/core/validation/task`
- [ ] Wrap in try/catch: `AuthError` → `unauthorized()`, `ZodError` → `handleZodError()`, else → `handleError()`
- [ ] Use PATCH for updates (not PUT)
- [ ] If mutation, call `logAction()` with before/after snapshots (see Critical Requirements)
- [ ] If mutation, wrap in `withTransaction()` (most mutations need this since they also write to undo_log)
- [ ] Return using response helpers (`success()`, `badRequest()`, etc.)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing

### Recurrence

- RFC 5545 RRULE strings (e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`
- Anchor fields (`anchor_time`, `anchor_dow`, `anchor_dom`) preserve the intended time-of-day across timezone and DST transitions (e.g., a task due at 9 AM stays at 9 AM local time after a DST change)
- `computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement
- Recurring tasks advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- One-off (non-recurring) tasks: when completed, marked `done=1` and `archived_at` set to current time

**Note**: Updating `rrule` also re-derives `anchor_*` fields and may recompute `due_at`. When logging this for undo, include the derived fields in `fieldsChanged` so undo restores the complete prior state.

### Undo

Every mutation is logged to `undo_log` with a snapshot of only the changed fields.

Functions from `@/core/undo`:
- `logAction(userId, action, description, fieldsChanged, snapshots)` — log mutation for undo
- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot`
- `createSnapshot(task, fieldsChanged)` — extract specific fields from a task object
- `executeUndo(userId)` — restores `before_state` from most recent undoable action
- `executeRedo(userId)` — replays `after_state` from most recent undone action

Undo history is per-user and works as a stack (last action undone first).

**Special case**: Undoing a task creation soft-deletes the task (sets `deleted_at`) rather than permanently deleting it.

## Testing

Three test tiers with JSON results in `test-results/`:

### Behavioral Tests

Location: `tests/behavioral/`

Core logic tests with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Test files run sequentially (not in parallel) because they share a single database.

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

| Attribute | Production | Development | Local |
|-----------|------------|-------------|-------|
| URL | tasks.tk11.mcnitt.io | tasks-dev.tk11.mcnitt.io | localhost:3000 |
| Port | 3100 | 3101 | 3000 |
| Service | opentask.service | opentask-dev.service | `npm run dev` |
| DB Path | /opt/opentask/data/tasks.db | /opt/opentask-dev/data/tasks.db | data/tasks.db |
| Server | tk11.mcnitt.io | tk11.mcnitt.io | — |
| Status | **Not yet provisioned** | Active | Active |

Remote instances run behind Caddy reverse proxy on Ubuntu 24.04. Server: `ssh admin@tk11.mcnitt.io`.

### Deployment

**Local development:**
```bash
npm run dev
```

**Remote deployment (dev or prod):** (Note: production is not yet provisioned — `deploy.sh prod` will fail until the systemd service is created.)
```bash
# 1. Verify
npm run type-check && npm run lint && npm test && npm run test:integration && npm run test:e2e

# 2. Deploy (requires explicit target — no default)
./scripts/deploy.sh dev   # Deploy to development
./scripts/deploy.sh prod  # Deploy to production
```

For iterative UI work where you're deploying frequently to dev, `npm run type-check && npm run lint && npm test` is sufficient between deploys. Run the full suite before deploying to production.

**What `deploy.sh` does:**
1. `npm run build` locally (fast — uses Mac CPU)
2. `rsync` the standalone bundle to server (excludes macOS-compiled `better_sqlite3.node`)
3. `rsync` `.next/static/` and symlinks it into the standalone working directory
4. `prebuild-install@7` on server — fetches Linux-native `better-sqlite3` binary (~3s, always runs to stay correct across Node.js and package version changes)
5. `systemctl restart` + status check

**Important details:**
- `public/` files are included in the standalone bundle — no separate sync needed.
- `data/` (the SQLite database) is never touched by deploys. Schema migrations run on app startup.
- The standalone output mirrors the build machine's absolute path. The script expects builds from `~/working_dir/opentask/`. If the repo moves, update `STANDALONE_APP` in `deploy.sh`. The script validates this path on the server and fails early if it's wrong.
- The deploy script creates `$DEPLOY_DIR/data/` on the server if it doesn't exist (safe for first deploys).

**Server debugging:** `ssh admin@tk11.mcnitt.io` then `journalctl -u opentask-dev -f` (or `opentask` for prod) to tail logs. The SQLite database is at the path shown in the Environments table.

**Rollback:** Checkout previous commit and re-deploy.

**First-time server setup:** The deploy script assumes the systemd service already exists. For a new environment, create the systemd unit file on the server (model it on `opentask-dev.service`) and run `systemctl enable` before the first deploy.

Git remote: Forgejo at `git.tk11.mcnitt.io` (use `tea` CLI for repo operations, not `gh`).
