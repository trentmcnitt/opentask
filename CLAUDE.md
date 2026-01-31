# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Local dev server (port 3000)
npm run build            # Production build (Next.js standalone — self-contained server bundle)
npm run lint             # ESLint
npm run type-check       # tsc --noEmit
npm test                 # Core logic tests (vitest, no HTTP/UI)
npm run test:integration # Integration tests (globalSetup builds and starts server automatically)
npm run test:e2e         # Playwright E2E tests (headless)
npm run test:e2e:ui      # Playwright with UI
npm run db:seed          # Seed database with initial users and projects
npm run db:migrate-due   # One-off data migration for due_at field format
```

After any code change, verify: `npm run type-check && npm run lint && npm test`

Run a single test file: `npx vitest tests/behavioral/some-spec.test.ts --run`

Run a single E2E file: `npx playwright test tests/e2e/some.spec.ts`

## Stack

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4. Mobile-first iOS-optimized UI.

## Conventions

- Import alias: `@/` maps to `src/`
- Source files: kebab-case. Types/interfaces: PascalCase. DB columns: snake_case. API fields: snake_case.
- Store dates as UTC. Convert to user timezone (from `AuthUser.timezone`) for API responses and UI.
- All mutation endpoints use PATCH, not PUT — only fields present in the request body are written.
- Every task mutation (create, update, delete, complete, snooze, archive) must be undoable. Log via `logAction()` before returning.
- `priority`: 0=unset, 1=low, 2=medium, 3=high, 4=urgent

## Architecture

See `docs/SPEC.md` for product requirements and feature scope.

### Source layout

- `src/core/` — Business logic, no UI. Auth, DB, tasks, recurrence, undo, validation, notifications, review.
- `src/components/` — React components (TaskList, TaskRow, TaskDetail, QuickAdd, etc.)
- `src/hooks/` — Custom React hooks (e.g., `useSelectionMode`)
- `src/app/api/` — REST API routes with dual auth (session cookies + Bearer tokens)
- `src/app/` — Pages (App Router): dashboard, login, task detail, projects, settings, history
- `src/lib/` — Utilities: `api-response.ts` (response helpers), `format-task.ts`, `format-rrule.ts`
- `src/types/` — Domain types (Task, User, Project, Note, Completion, AuthUser) and API route types
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs

### Database

SQLite singleton via `getDb()` from `@/core/db`. Schema in `src/core/db/schema.sql` — `getDb()` applies it idempotently on first connection. WAL mode (write-ahead logging for concurrent reads), 5s busy timeout, foreign keys enforced. DB path controlled by `OPENTASK_DB_PATH` env var (default: `data/tasks.db`).

All DB operations are synchronous (better-sqlite3). Wrap multi-step mutations in `withTransaction()` — without it, partial failures leave the DB inconsistent. JSON columns (labels, undo snapshots) are stored as TEXT; parse and serialize in application code.

### Auth

Dual authentication checked in order:
1. **Bearer token** — `Authorization: Bearer <token>`, validated by `getAuthUser()` against the `api_tokens` table. If header present but invalid, return 401 immediately — never fall back to session auth.
2. **Session cookie** — NextAuth JWT strategy with credentials provider (username/password, no OAuth).

Use `getAuthUser(request)` or `requireAuth(request)` from `@/core/auth`. Returns `AuthUser { id, email, name, timezone }`.

### API patterns

Typical route handler pattern:

```ts
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request)
  const { id } = await context.params
  const body = UpdateTaskSchema.parse(await request.json())
  const result = updateTask(user.id, user.timezone, Number(id), body)
  return success(result)
}
```

- Response format: `success(data)` / `badRequest()` / `unauthorized()` / `notFound()` etc. from `@/lib/api-response`
- Success: `{ data: ... }`, Error: `{ error, code, details? }`
- Note: Next.js 16 requires awaiting dynamic params: `const { id } = await context.params`
- Validate inputs at the API boundary with Zod. Wrap with `handleZodError()` to convert validation failures into structured 400 responses.

### Recurrence

- RFC 5545 RRULE strings (e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`
- Anchor fields (`anchor_time`, `anchor_dow`, `anchor_dom`) are computed automatically when a task is created or its RRULE changes — these prevent date drift across timezone/DST transitions
- `computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement
- Recurring tasks advance in place: completing a daily task moves `due_at` from Jan 31 to Feb 1 and leaves `done=0` (the task reappears)
- One-off tasks: marked `done=1, archived_at=now`

### Undo

Every mutation logged to `undo_log` with field-level delta snapshots (only changed fields are recorded). `executeUndo()` restores before_state, `executeRedo()` replays after_state. Per-user, stack-based.

## Testing

Three test tiers with JSON results in `test-results/`:

1. **Behavioral** (`tests/behavioral/`) — Core logic tests, no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Sequential execution.
2. **Integration** (`tests/integration/`) — Real HTTP against `next start`. globalSetup builds the app and starts the server automatically. Uses hardcoded test tokens (`TOKEN_A`/`TOKEN_B`, defined in `tests/integration/helpers.ts`). `resetTestData()` calls `POST /api/test/reset` between test files. The reset endpoint only functions when `OPENTASK_TEST_MODE=1` is set.
3. **E2E** (`tests/e2e/`) — Playwright, headless Chromium. Separate DB (`data/test-e2e.db`). `authenticatedPage` fixture logs in via real form. Run with `--headed` to see the browser.

Test helpers:
- `tests/helpers/setup.ts` — behavioral
- `tests/integration/helpers.ts` — integration
- `tests/e2e/fixtures.ts` — E2E

## Environments

Three instances (Trent refers to these as "prod/production instance," "dev/development instance," and "local/localhost instance"):

| | Production | Development | Local |
|---|---|---|---|
| URL | tasks.tk11.mcnitt.io | tasks-dev.tk11.mcnitt.io | localhost:3000 |
| Port | 3100 | 3101 | 3000 |
| Service | opentask.service | opentask-dev.service | `npm run dev` |
| DB | /opt/opentask/data/tasks.db | /opt/opentask-dev/data/tasks.db | data/tasks.db |
| Server | tk11.mcnitt.io | tk11.mcnitt.io | local machine |

Both remote instances run behind Caddy reverse proxy. Deploy with `scripts/deploy.sh [prod|dev]` — builds locally, rsyncs the standalone bundle to the server, and restarts the systemd service.

Git remote: Forgejo at `git.tk11.mcnitt.io` (use `tea` CLI for repo operations, not `gh`).
