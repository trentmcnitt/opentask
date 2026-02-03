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

## Development Workflow

After every code change, run the quick check:

```bash
npm run type-check && npm run lint && npm test
```

### When to Run Which Tests

| Change type                                   | What to run                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Any code change                               | `npm run type-check && npm run lint && npm test`                                                                                          |
| API routes, core logic, validation, auth      | Above + `npm run test:integration`                                                                                                        |
| UI components, hooks, styles, client behavior | Above + `npm run test:e2e` + **deploy to dev + browser verification (see [UI Verification](#ui-verification) — mandatory, not optional)** |
| Iterative dev deploys                         | Quick check between deploys is sufficient                                                                                                 |
| Production deploy                             | All test suites (see Deployment section)                                                                                                  |

Run a single test: `npx vitest tests/behavioral/some-spec.test.ts --run`
Run a single E2E test: `npx playwright test tests/e2e/some.spec.ts`

### UI Verification

**Any change that touches UI, components, styles, or client-side behavior is NOT complete until you have deployed to dev and verified it in the browser yourself.** Do not tell the user the work is done, suggest they verify, or ask if they'd like you to deploy. You must do it — every time, automatically, without being asked.

1. Deploy to dev: `./scripts/deploy.sh dev` — do this immediately after the quick check passes, before reporting results
2. **Playwright**: navigate to the affected page, take screenshots at both desktop (1280×800+) and mobile (375×812) viewports, confirm it renders correctly at each size
3. **Chrome DevTools MCP**: check for console errors/warnings and failed network requests
4. **If interactive** (clicks, swipes, form submissions, state changes): test the actual user flow with Playwright — don't just look at a static screenshot
5. If something looks wrong, fix it and re-deploy — iterate until it's right
6. Share the dev link only after all browser verification steps pass: https://tasks-dev.tk11.mcnitt.io

**To be explicit**: "You'll want to deploy and verify" is not acceptable. You deploy it. You verify it. You report what you found.

**UI change is not done until every box is checked:**

- [ ] Quick check passes (`npm run type-check && npm run lint && npm test`)
- [ ] Deployed to dev via `./scripts/deploy.sh dev`
- [ ] Playwright: screenshots at desktop (1280x800+) and mobile (375x812) viewports
- [ ] Chrome DevTools MCP: no console errors/warnings, no failed network requests
- [ ] Interactive flows tested with Playwright (if applicable — clicks, form submissions, state changes)
- [ ] Fixes applied and re-deployed if anything looked wrong
- [ ] Dev link shared with results: https://tasks-dev.tk11.mcnitt.io

Backend/logic-only changes with no UI touchpoint do not need browser verification — passing tests are sufficient.

**Dev login credentials** are in `.secrets` at the project root. Read that file to get the username and password before logging in via Playwright.

## Critical Requirements

These rules prevent data-loss bugs and security issues. Violating them breaks undo, causes data inconsistencies, or creates auth bypasses.

### UI verification is mandatory

Any change that touches UI, components, styles, or client-side behavior **must** be deployed to dev and verified in the browser before reporting the work as done. This is not optional and not deferrable. Tests passing is necessary but not sufficient — you must also visually confirm the change works. See the [UI Verification](#ui-verification) section for the full checklist.

### Undo logging

Every task mutation must call `logAction()` from `@/core/undo` after performing the mutation but before returning the response. This includes create, update, delete, complete, snooze, and archive operations. Use `createTaskSnapshot()` to build the before/after snapshots:

```ts
const snapshot = createTaskSnapshot(beforeTask, afterTask, ['priority'], completionId)
logAction(user.id, 'update', 'Updated priority', ['priority'], [snapshot])
```

The `completionId` parameter is only needed when completing a recurring task — it links the completion record to the undo snapshot.

**Non-undoable operations**: "Empty Trash" permanently deletes data and cannot be undone. Any permanent deletion must require explicit user confirmation. All other task deletions are soft-deletes (set `deleted_at`).

### Transactions

All mutations that call `logAction()` must use `withTransaction()` from `@/core/db`, since the mutation and the undo log write must be atomic:

```ts
withTransaction((db) => {
  db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(newPriority, taskId)
  logAction(user.id, 'update', 'Updated priority', ['priority'], [snapshot])
})
```

Core mutation functions in `src/core/tasks/` handle their own transactions and undo logging internally. Route handlers call the core function directly — they do not need to wrap the call in `withTransaction()` themselves.

### Auth security

If an Authorization header is present but the token is invalid, return 401 immediately — never fall through to session auth. See the Auth section for the full decision table.

## Conventions

### Naming

- Import alias: `@/` maps to `src/`
- React components: PascalCase (`AddTaskForm.tsx`, `TaskRow.tsx`)
- Other source files: kebab-case (`api-response.ts`, `critical-alerts.ts`)
- Types/interfaces: PascalCase (`Task`, `AuthUser`, `UpdateTaskOptions`)
- DB columns: snake_case (`due_at`, `created_at`, `anchor_dow`)
- API fields: snake_case (`project_id`, `snoozed_from`)

### Coding Rules

- Store all dates as UTC in the database. API responses and UI code must convert dates to the user's timezone (stored in `AuthUser.timezone`).
- All mutation endpoints use PATCH, not PUT — the handler updates only fields present in the request body.
- `priority` values: 0=unset, 1=low, 2=medium, 3=high, 4=urgent
- All task deletions are soft-deletes (set `deleted_at`). The only hard-delete operation is "Empty Trash."
- When you need a UI primitive not already in `src/components/ui/`, install it with `npx shadcn@latest add <component>`. This generates the file in `src/components/ui/`.
- **Never suppress lint errors or warnings** (e.g., `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`) without explicit approval from the user. Fix the root cause instead. If a fix is genuinely impossible, ask the user before adding any suppression comment.
- **No brittle fixes or tolerances.** Don't add buffers, timeouts, or tolerances to work around symptoms. If something seems like a race condition or timing issue, understand the actual requirement first. Code should run like clockwork, not something mushy. Don't attempt hacky workarounds without understanding the real problem.
- **Document unintuitive or complex code within the same code file.** Non-obvious behavior (e.g., UX flows, UI layouts, backend behaviors) can be hard to infer from code at-a-glance. Add a comment block explaining what the behavior is and why, so future readers don't have to reverse-engineer it. Do this as features are built or worked on, whenever it seems prudent. It can save a lot of trouble and confusion when coming back to work on it.

## Architecture

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA with iOS optimization. Uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory for deployment. See `docs/SPEC.md` for product requirements and feature scope.

### Source Layout

- `src/core/` — Business logic (no UI): auth, db, tasks, recurrence, undo, validation, notifications, review
- `src/components/` — React components (`TaskList.tsx`, `TaskRow.tsx`, `TaskDetail.tsx`, `SwipeableRow.tsx`, `SelectionProvider.tsx`, `AppLayout.tsx`, etc.)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode.ts`, `useGroupSort.ts`)
- `src/app/api/` — REST API routes with dual auth (session cookies + Bearer tokens)
- `src/app/` — Pages (App Router): root (`/`), login, task detail, projects, settings, history, archive, trash
- `src/lib/` — Utilities: `api-response.ts`, `format-task.ts`, `format-rrule.ts`, `toast.ts`, `utils.ts`
- `src/types/` — Domain types (`index.ts`) and API route types (`api.ts`)
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs

### Database

- **Singleton**: Access via `getDb()` from `@/core/db`
- **Schema**: `src/core/db/schema.sql` — the app applies it idempotently on first connection
- **Config**: `OPENTASK_DB_PATH` env var (default: `data/tasks.db`). See `.env.example` for all env vars.
- **Mode**: WAL (write-ahead logging), 5s busy timeout, foreign keys enforced
- **Operations**: All synchronous (better-sqlite3)
- **JSON columns**: Labels and undo snapshots stored as TEXT; parse/serialize in application code
- **Schema changes**:
  - Modify `src/core/db/schema.sql` directly
  - Only additive changes (new tables, new columns with defaults) apply idempotently
  - For destructive changes (rename/remove columns), add an `ALTER TABLE` migration in `initializeSchema()` in `src/core/db/index.ts`
  - To test schema changes from scratch, delete the local `data/tasks.db` file
  - Remote databases pick up schema changes on next app restart

### Auth

Dual authentication checked in order:

| Credential      | Valid? | Result                                     |
| --------------- | ------ | ------------------------------------------ |
| Bearer token    | Yes    | Authenticate via token                     |
| Bearer token    | No     | Return 401 (never fall through to session) |
| No Bearer token | —      | Fall through to session cookie             |
| Session cookie  | Yes    | Authenticate via session                   |
| Session cookie  | No     | Return 401                                 |

**Functions** from `@/core/auth`:

- `requireAuth(request)` — Returns `AuthUser` or throws `AuthError`. Use for protected endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when you need more control over the error response (the existing route handlers use this pattern with a manual null check).

`AuthUser` shape: `{ id, email, name, timezone }`.

### API Patterns

Typical route handler pattern (from `src/app/api/tasks/[id]/route.ts`):

```ts
import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError, handleZodError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { updateTask } from '@/core/tasks'
import { validateTaskUpdate } from '@/core/validation'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()
    const { id } = await context.params // Next.js 16 requires await
    const input = validateTaskUpdate(await request.json())
    const { task, fieldsChanged } = updateTask({
      userId: user.id,
      userTimezone: user.timezone,
      taskId: parseInt(id),
      input,
    })
    return success({ ...formatTaskResponse(task), fields_changed: fieldsChanged })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    return handleError(err)
  }
}
```

Note: `updateTask()` handles its own transaction and undo logging internally — the route handler does not need to call `withTransaction()` or `logAction()` directly.

- Response helpers from `@/lib/api-response`: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()`
- Success format: `{ data: ... }` — Error format: `{ error, code, details? }`
- Validation functions in `@/core/validation/task.ts` (`validateTaskCreate`, `validateTaskUpdate`, etc.) — these call Zod `.parse()` internally

### New Endpoint Checklist

- [ ] Use `getAuthUser(request)` or `requireAuth(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with validation functions from `@/core/validation`
- [ ] Wrap in try/catch: `AuthError` → `unauthorized()`, `ZodError` → `handleZodError()`, else → `handleError()`
- [ ] Use PATCH for updates (not PUT)
- [ ] If mutation, ensure the core function calls `logAction()` with before/after snapshots (see Critical Requirements)
- [ ] If mutation, ensure the core function uses `withTransaction()` (most mutations need this since they also write to undo_log)
- [ ] Return using response helpers (`success()`, `badRequest()`, etc.)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing

### Recurrence

- RFC 5545 RRULE strings (the iCalendar recurrence rule standard, e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`
- Anchor fields (`anchor_time`, `anchor_dow`, `anchor_dom`) preserve the intended local time across DST transitions (e.g., a task due at 9 AM stays at 9 AM local time when clocks change)
- `computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement
- Recurring tasks advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- One-off (non-recurring) tasks: when completed, the app sets `done=1` and `archived_at` to the current time

**Important**: Updating `rrule` also re-derives `anchor_*` fields and may recompute `due_at`. When logging this for undo, include all derived fields in `fieldsChanged` so undo restores the complete prior state:

```ts
// Example: fieldsChanged for an rrule update
;['rrule', 'anchor_time', 'anchor_dow', 'anchor_dom', 'due_at']
```

### Snooze

**Snooze is just changing `due_at`.** That's all it is. It's called "snoozing" instead of changing the due date, because in cases where a task is recurring, the recurrence schedule doesn't change (daily 9:00am snoozed until noon then completed will still re-generate as a task due at 9:00am tomorrow)

### Undo

The app logs every mutation to `undo_log` with a snapshot of only the changed fields.

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

Behavioral tests exercise core logic with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Test files run sequentially (not in parallel) because they share a single database.

Helper: `tests/helpers/setup.ts`

### Integration Tests

Location: `tests/integration/`

Sends real HTTP requests to a `next start` server. The `globalSetup.ts` builds the app and starts the server automatically. Uses hardcoded test tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this calls `POST /api/test/reset`, which is only available when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

### E2E Tests

Location: `tests/e2e/`

Playwright with headless Chromium. Uses separate DB (`data/test-e2e.db`). The `authenticatedPage` fixture logs in via the real login form.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

### Test Data Seeding

`scripts/seed-test.ts` provides deterministic test data seeding used by integration and E2E tests.

### Time-Based Testing

Tests must be **time-agnostic** — they should pass regardless of when they run. Use these patterns:

**Behavioral tests**: Use `vi.setSystemTime()` to freeze the clock at a known moment:

```typescript
import { vi, beforeEach, afterEach } from 'vitest'

describe('My tests', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('task completion advances due date', () => {
    // localTime(8, 0) now creates Jan 15 at 8am — 2 hours in the past
    // Tests are deterministic regardless of actual wall-clock time
  })
})
```

**Test data seeding**: Always use future dates for "upcoming" tasks:

```typescript
// WRONG: Could be in the past depending on when tests run
const today5pm = DateTime.now().set({ hour: 17 })

// RIGHT: Always in the future
const tomorrow5pm = DateTime.now().plus({ days: 1 }).set({ hour: 17 })
```

**Why not just use relative dates everywhere?** Clock mocking is preferred for behavioral tests because:

1. Complete determinism — tests behave identically at any time
2. Self-documenting — the frozen time is visible in the test
3. Enables testing edge cases (DST transitions, year boundaries)
4. Industry standard practice

See `tests/behavioral/format-date.test.ts` and `tests/behavioral/bo-bulk.test.ts` for examples.

## Environments

| Setting | Production                  | Development                     | Local          |
| ------- | --------------------------- | ------------------------------- | -------------- |
| URL     | tasks.tk11.mcnitt.io        | tasks-dev.tk11.mcnitt.io        | localhost:3000 |
| Port    | 3100                        | 3101                            | 3000           |
| Service | opentask.service            | opentask-dev.service            | `npm run dev`  |
| DB Path | /opt/opentask/data/tasks.db | /opt/opentask-dev/data/tasks.db | data/tasks.db  |
| Server  | tk11.mcnitt.io              | tk11.mcnitt.io                  | —              |
| Status  | Active                      | Active                          | Active         |

Remote instances run behind Caddy reverse proxy on Ubuntu 24.04. Server: `ssh admin@tk11.mcnitt.io`.

### Deployment

Ensure changes are committed before deploying — the rollback strategy depends on checking out a previous commit.

**Local development:**

```bash
npm run dev
```

**Remote deployment (dev or prod):**

```bash
# 1. Verify (full suite for production; quick check sufficient for iterative dev deploys)
npm run type-check && npm run lint && npm test && npm run test:integration && npm run test:e2e

# 2. Deploy (requires explicit target — no default)
./scripts/deploy.sh dev   # Deploy to development
./scripts/deploy.sh prod  # Deploy to production
```

**What `deploy.sh` does:**

1. `npm run build` locally (fast — uses Mac CPU)
2. `rsync` the standalone bundle to the server (excludes the macOS-compiled `better_sqlite3.node`)
3. `rsync` `.next/static/` and symlinks it into the standalone working directory
4. `prebuild-install` (v7) on the server — fetches a Linux-native `better-sqlite3` binary (~3s, always runs to stay correct across Node.js and package version changes)
5. `systemctl restart` + status check

**Important details:**

- `public/` files are included in the standalone bundle — no separate sync needed.
- `data/` (the SQLite database) is never touched by deploys. Schema migrations run on app startup.
- The standalone output embeds the build machine's absolute path in its directory structure. The script expects builds from `~/working_dir/opentask/`. If you clone the repo to a different path, update `STANDALONE_APP` in `deploy.sh`. The script validates this path on the server and fails early if it's wrong.
- The deploy script creates `$DEPLOY_DIR/data/` on the server if it doesn't exist (safe for first deploys).

**Server debugging:** `ssh admin@tk11.mcnitt.io` then `journalctl -u opentask-dev -f` (or `opentask` for prod) to tail logs. The SQLite database is at the path shown in the Environments table.

**Rollback:** Check out the previous commit and re-deploy.

**First-time server setup:** The deploy script assumes the systemd service already exists. For a new environment, create the systemd unit file on the server (model it on `opentask-dev.service`) and run `systemctl enable` before the first deploy.

Git remote: Forgejo (self-hosted Git forge) at `git.tk11.mcnitt.io` (use `tea` CLI for repo operations, not `gh`).
