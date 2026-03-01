# CLAUDE.md

OpenTask is a self-hosted task management PWA. This file is the authoritative reference for contributing to this codebase.

## Architecture

Next.js 16 (App Router) + React 19 + TypeScript + SQLite (better-sqlite3) + NextAuth 5 + Tailwind CSS 4 + Shadcn UI. Mobile-first PWA optimized for iOS. Basic offline support: `public/sw.js` caches the app shell so navigation works offline, but there is no offline data access or mutation queuing. Uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory for deployment. A native iOS companion app (`ios/`) wraps the PWA in a WKWebView and adds APNs push notifications with interactive snooze/done actions. See `docs/SPEC.md` for product requirements, `docs/ROADMAP.md` for planned features, `docs/AUTOMATION.md` for external API integration (Shortcuts, Claude Code, scripts), and `DEV_LOG.md` for a reverse-chronological journal of design decisions, problems overcome, and narrative context that can't be inferred from git history alone.

### Source layout

- `src/core/` — Business logic (no UI): auth, db, tasks, recurrence, undo, validation, notifications, review, stats, ai, activity
- `src/components/` — React components (see directory for full inventory)
- `src/components/ui/` — Shadcn UI primitives (button, input, checkbox, dialog, sheet, etc.)
- `src/hooks/` — Custom React hooks (`useSelectionMode.ts`, `useGroupSort.ts`, `useTimezone.ts`, `useKeyboardNavigation.ts`, etc.)
- `src/app/api/` — REST API routes with triple auth (Bearer tokens + proxy headers + session cookies)
- `src/app/` — Pages (App Router): root (`/`), login, tasks/[id], projects, projects/[id], settings, history, archive, trash
- `src/lib/` — Utilities (`api-response.ts`, `format-task.ts`, `format-date.ts`, `format-rrule.ts`, `logger.ts`, `priority.ts`, `toast.ts`, `utils.ts`, etc.)
- `src/types/` — Domain types (`index.ts`), API route types (`api.ts`), NextAuth augmentation (`next-auth.d.ts`)
- `src/instrumentation.ts` — Next.js server init hook that starts notification cron jobs
- `ios/` — Native iOS companion app (see [iOS App](#ios-app-ios) section)
- `assets/` — Source logo and branding files (Pixelmator sources + exported PNGs). Copy exports to `public/` when updated.

### UI vocabulary

| Term        | Component                                 | Description                                                                 |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Top bar     | `src/components/Header.tsx`               | Fixed header with snooze button, task count, and navigation                 |
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

Three auth methods checked in order:

| Credential      | Valid? | Result                                     |
| --------------- | ------ | ------------------------------------------ |
| Bearer token    | Yes    | Authenticate via token                     |
| Bearer token    | No     | Return 401 (never fall through to session) |
| No Bearer token | —      | Check proxy header (if configured)         |
| Proxy header    | Yes    | Authenticate via proxy (Authelia, etc.)    |
| Proxy header    | No     | Fall through to session cookie             |
| Session cookie  | Yes    | Authenticate via session                   |
| Session cookie  | No     | Return 401                                 |

Proxy header auth is enabled by setting `OPENTASK_PROXY_AUTH_HEADER` to the header name (e.g., `Remote-User`). See `src/core/auth/proxy.ts`.

**Functions** from `@/core/auth`:

- `requireAuth(request)` — Returns `AuthUser` or throws `AuthError`. Preferred for new endpoints.
- `getAuthUser(request)` — Returns `AuthUser | null`. Use when you need to customize the 401 response (e.g., returning a different message or status code based on context). Most existing route handlers use this with a manual null check.

`AuthUser` shape: `{ id, email, name, timezone, default_grouping: 'time' | 'project' | 'unified' }`.

**Login is username-based, not email-based.** The login form accepts a username (the `name` column, case-insensitive). Email is stored but not used for login. Dev credentials are in `.secrets` at the project root.

NextAuth is configured in `src/app/api/auth/[...nextauth]/auth.ts` (credentials provider, JWT sessions, custom callbacks).

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
npm run dump-prompts     # Dump rendered AI prompts to .tmp/ (see AI quality testing)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with coverage report
npm run db:seed          # Seed database with initial users and projects
npm run db:seed-demo     # Seed demo user with ~55 generic professional tasks
npm run db:reset-demo    # Delete and re-create all demo user data
npm run db:create-token  # Create API token: npm run db:create-token -- <user> [name]
```

**Quick check** (referenced throughout this file): `npm run type-check && npm run lint && npm test`

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

For task creation, pass `{ id: taskId }` as `beforeTask` (there is no full before-state). On undo, the `'create'` action type causes the system to soft-delete the task (since there is no before-state to restore). See `createTask()` in `src/core/tasks/create.ts` for the pattern.

### All deletions must be soft deletes

All task deletions are soft-deletes (set `deleted_at`). The only hard-delete operation is "Empty Trash," which permanently deletes data, cannot be undone, and must require explicit user confirmation.

```ts
db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, taskId)
```

### Reject invalid tokens immediately

If an Authorization header is present but the token is invalid, return 401 immediately — never fall through to session auth. See the [Authentication](#authentication) section for the full decision table.

### Never suppress lint errors or warnings

Never use `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, or similar suppression comments without explicit approval from the user. Fix the root cause instead. If a fix is genuinely impossible, ask the user before adding any suppression comment.

### No brittle fixes or tolerances

Don't add buffers, timeouts, or tolerances to work around symptoms. If something seems like a race condition or timing issue, understand the actual requirement first. Code should be deterministic and precise, not held together by tolerances and timeouts. For example, if a test fails intermittently, find the ordering or state bug rather than adding `setTimeout` or retry loops.

## Due Date Philosophy

OpenTask is not a traditional task manager. Due dates for most tasks are **reminders, not deadlines**. Understanding that distinction is critical for interpreting task data correctly, especially in AI features. See `docs/DESIGN.md` for the full rationale.

**Priority determines whether a due date is a deadline or a notification trigger:**

- **Priority 0-3 (Unset/Low/Medium/High):** `due_at` means "remind me at this time." These tasks are eligible for bulk snooze. Being "overdue" just means `due_at` has passed — for low-priority tasks it's the normal state, not a problem. For high-priority tasks, being overdue is more significant but still bulk-snoozable.
- **Priority 4 (Urgent):** `due_at` is a hard deadline. Urgent tasks are never bulk-snoozed — they must be snoozed individually, so every due date change is a deliberate decision. Being overdue is always significant. `URGENT_PRIORITY = 4` in `src/lib/priority.ts`.

| Priority        | Due date means | Bulk snooze | "Overdue" significance |
| --------------- | -------------- | ----------- | ---------------------- |
| 0-1 (Unset/Low) | Reminder       | Eligible    | Normal — not a problem |
| 2 (Medium)      | Reminder       | Eligible    | Low                    |
| 3 (High)        | Deadline       | Eligible    | Significant            |
| 4 (Urgent)      | Hard deadline  | Never       | Critical               |

**Bulk snooze:** One pass — all overdue P0-P3 tasks are snoozed, P4 (Urgent) is always excluded. No tiers, no multi-click flow.

**Implications for code and AI:**

- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- The gap between `original_due_at` and `due_at` shows total drift but not how many times or why the task was snoozed. Don't infer snooze counts or user intent from dates alone.
- `snooze_count` is a lifetime stat incremented on every snooze (including bulk). High counts are normal, not a sign of avoidance.
- For P0-3 tasks, avoid language like "deferred three times" (implies conscious decisions). Prefer factual framing: "has been on your list for 3 weeks."

## Task Model Reference

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

Snooze sets `due_at` to a new value without modifying recurrence. For recurring tasks, the original schedule is preserved: a daily 9:00 AM task snoozed to noon and then completed will still regenerate as due at 9:00 AM tomorrow. Bulk snooze uses two-tier priority filtering — see [Due Date Philosophy](#due-date-philosophy).

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

- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot`. See [Critical Requirements](#every-mutation-must-be-atomic-and-logged-for-undo) for usage details and the `completionId` pattern.
- `executeUndo(userId)` — restores the task to `before_state` from the most recent undoable action
- `executeRedo(userId)` — re-applies `after_state` from the most recent undone action

Undo history is per-user and works as a stack (last action undone first).

### Task access

`canUserAccessTask(userId, task)` from `@/core/tasks` — returns `true` if the user owns the task or it's in a shared project. Use this in route handlers that need to verify access.

### Purge modules

Automatic data cleanup modules run on a schedule via cron jobs started in `src/instrumentation.ts`:

- `src/core/undo/purge.ts` — prunes old undo log entries
- `src/core/stats/purge.ts` — cleans up stale stats data
- `src/core/tasks/purge-completions.ts` — removes old task completion records
- `src/core/tasks/purge-trash.ts` — permanently deletes tasks that have been in trash past the retention period
- `src/core/ai/purge.ts` — removes old AI generation artifacts

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
- Update endpoints use PATCH, not PUT — the handler updates only fields present in the request body.
- When you need a UI primitive not already in `src/components/ui/`, install it with `npx shadcn@latest add <component>`. This generates the file in `src/components/ui/`.
- **Document unintuitive or complex code within the same code file.** Non-obvious behavior (e.g., UX flows, UI layouts, backend behaviors) can be hard to infer from code at a glance. Add a comment block explaining what the behavior is and why, so future readers don't have to reverse-engineer it. Do this as you build or modify features — when in doubt, err on the side of documenting.
- ESLint warns on: `max-lines-per-function: 150` (excluding blank lines and comments), `complexity: 20`, `max-depth: 5`, `max-nested-callbacks: 4`.
- When modifying an existing endpoint that uses `getAuthUser`, you do not need to migrate it to `requireAuth` unless explicitly asked.
- See [Critical Requirements](#critical-requirements) for the lint suppression and brittle-fix rules.

### Tooling

- **Pre-commit hook**: `lint-staged` runs Prettier and ESLint on staged files before every commit. If a commit is rejected, fix the issues and retry — do not bypass with `--no-verify`. Common failures: Prettier formatting (fix with `npm run format`), ESLint errors (fix the code, do not suppress).
- **Formatting**: Prettier (semi: false, singleQuote: true, printWidth: 100, Tailwind plugin). Run `npm run format` to format all files.

## API Reference

### Route handler pattern

All route handlers are wrapped with `withLogging()` from `@/lib/with-logging`, which logs every request with method, path, status, duration, and auth type. Log level varies by status: 5xx → `error`, 4xx → `warn`, 2xx → `info`. Uses the `http` namespace.

Preferred pattern using `requireAuth` (adapted from `src/app/api/tasks/[id]/route.ts`, which still uses `getAuthUser`):

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

Both `getAuthUser` and `requireAuth` are valid — see [Authentication](#authentication) for guidance on which to use. All handlers should log errors before calling `handleError()`.

Note: `updateTask()` handles its own transaction and undo logging internally.

### New endpoint checklist

Follow the pattern above, and verify:

- [ ] Use `requireAuth(request)` (preferred) or `getAuthUser(request)` for authentication
- [ ] Await `context.params` (Next.js 16 requirement)
- [ ] Validate request body with validation functions from `@/core/validation` (`validateTaskCreate`, `validateTaskUpdate`, etc. — these call Zod `.parse()` internally)
- [ ] Wrap in try/catch: `AuthError` → `unauthorized()`, `ZodError` → `handleZodError()`, else → `handleError()`. Core functions may also throw `NotFoundError`, `ForbiddenError`, or `ValidationError` from `@/core/errors` — handle these alongside `AuthError` and `ZodError`.
- [ ] Use PATCH for updates (not PUT)
- [ ] If you created a new core mutation function, ensure it uses `withTransaction()` and calls `logAction()` with before/after snapshots (see [Critical Requirements](#critical-requirements))
- [ ] Format task responses with `formatTaskResponse()` from `@/lib/format-task`
- [ ] Return using response helpers: `success()`, `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `internalError()`, `handleZodError()`, `handleError()` — success format: `{ data: ... }`, error format: `{ error, code, details? }`
- [ ] Wrap handlers with `withLogging()` from `@/lib/with-logging` (use named function expression for stack traces)
- [ ] Add tests: behavioral (core logic), integration (HTTP), E2E if user-facing

## Development and Testing

### When to run which tests

If a change spans multiple rows in this table, combine the test suites from all matching rows. If a change affects what the user sees on screen (even via a shared utility like `format-task.ts`), treat it as a UI change.

| Change type                                   | What to run                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Every change (always run)                     | The quick check (`npm run type-check && npm run lint && npm test`)                                                                      |
| API routes, core logic, validation, auth      | Quick check + `npm run test:integration`                                                                                                |
| AI prompts, enrichment logic, AI behavior     | Quick check + `npm run test:quality` (both layers, requires `OPENTASK_AI_ENABLED=true`) — see [AI quality testing](#ai-quality-testing) |
| UI components, hooks, styles, client behavior | Quick check + `npm run test:e2e` + **deploy to dev + [browser verification](#ui-verification)**                                         |
| Refactoring / code reorganization             | All test suites                                                                                                                         |
| Production deploy                             | All test suites (see [Deployment](#deployment) section)                                                                                 |

During rapid iteration (deploy, verify in browser, fix, re-deploy), the quick check between deploys is sufficient. Run the full checklist on the final version before reporting results.

E2E tests (run locally) and browser verification (run against dev) are complementary — both are required for UI changes.

Run a single test: `npx vitest tests/behavioral/some-spec.test.ts --run`
Run a single E2E test: `npx playwright test tests/e2e/some.spec.ts`

### AI quality testing

**Production has essentially no feedback loop for AI quality.** There is no user rating system, no A/B testing, no way to know if the AI is producing good results in the field. Quality testing IS the quality bar — the AI will only perform as well as our tests prove it can. This makes two things critical:

1. **How extensive and realistic the quality test scenarios are** — scenarios must cover the full range of real-world inputs: dictation artifacts, typos, edge cases, ambiguous phrasing, colloquial language, and every field combination. If a scenario isn't tested, assume it doesn't work.
2. **How well the AI holds up under that testing** — every scenario must be evaluated in Layer 2, and any score below 6 means the prompt needs iteration. Do not ship prompt changes that degrade quality on existing scenarios.

**`test:quality` is a two-step process.** Running `npm run test:quality` is only Layer 1 (generation + structural validation). You must then perform Layer 2 (quality evaluation) by following the instructions printed to stdout. Do not report quality tests as complete until Layer 2 is done. See `docs/AI.md` for details. Layer 1 validates structural correctness (valid JSON, required fields, type checks). Layer 2 evaluates semantic quality (is the AI output actually good?) using an LLM-as-judge rubric.

**`dump-prompts` is the only reliable way to see what the AI actually receives.** Prompt source code is spread across `src/core/ai/prompts.ts`, `src/core/ai/quick-take.ts`, shared sections, and template literals — reading the source alone is not sufficient. Always dump and review the fully rendered prompt before and after any AI prompt change. This is non-negotiable: if you're touching AI prompts, you must run `dump-prompts` to verify the final output.

```bash
npm run dump-prompts                              # All prompts (templates only) → .tmp/prompts.txt
npm run dump-prompts -- --feature enrichment      # Just the enrichment prompt
npm run dump-prompts -- --feature insights         # Just the insights prompt
npm run dump-prompts -- --feature whats_next       # Just the what's next prompt
npm run dump-prompts -- --feature quick_take       # Just the quick take prompt (shows cold path + warm slot split)
npm run dump-prompts -- --scenario insights-medium-list  # Render with a test scenario's task data
npm run dump-prompts -- --list                     # List available scenarios
```

**Targeted re-runs** for iterating on failures without re-running the full suite. Layer 2 evaluation still applies to these re-runs — follow the same two-step process.

```bash
npm run test:quality:retry                                    # Re-run failures from last run
npm run test:quality:run -- enrich-simple-clean               # Run one scenario
npm run test:quality:run -- insights-boundary-stale insights-mixed-priorities  # Run multiple
```

**When modifying AI prompts or enrichment logic:**

1. **Dump the rendered prompt first** (`npm run dump-prompts -- --feature <feature>`) — read the full output in `.tmp/` and check for contradictions, stale rules, and redundancy. Do this before writing any code.
2. Make your changes
3. **Dump again after changes** — verify the rendered output matches your intent. The source code alone won't show you the complete picture.
4. Run both Layer 1 and Layer 2 on ALL scenarios (not just new ones)
5. If any scenario regresses, fix the prompt before proceeding
6. When adding new behavior, add scenarios that test it — untested behavior is unverified behavior
7. Scenarios live in `tests/quality/scenarios/` organized by category

### Pre-existing test failures

If a test fails that is unrelated to your current change, report it to the user before proceeding. Do not silently skip failing tests. After reporting a pre-existing failure, you may continue with your current work unless instructed otherwise. Do not modify the failing test to make it pass.

### UI verification

**Any UI change must be deployed to dev and verified in the browser before reporting the work as done.** Do not tell the user the work is done, suggest they verify, or ask if they'd like you to deploy — you deploy it, you verify it, you report what you found.

During iterative UI verification deploys to dev, committing between each deploy is not required. Commit once the final verified version is ready, then re-deploy from the clean commit.

**Dev login credentials** are in `.secrets` at the project root. Read that file before logging in via Playwright.

**UI change is not done until every box is checked.** Pre-existing test failures (reported to the user per the policy above) do not block this checklist — note them in your results.

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

Behavioral tests exercise core logic with no HTTP or UI. Each file calls `setupTestDb()` in `beforeAll` which resets DB and seeds a test user. Test files run sequentially (not in parallel) because they share a single database.

Helper: `tests/helpers/setup.ts`

### Integration tests

Location: `tests/integration/`

Integration tests send real HTTP requests to a running `next start` server (the production build). The `globalSetup.ts` builds the app and starts the server automatically. These tests authenticate using hardcoded tokens (`TOKEN_A`/`TOKEN_B` in `tests/integration/helpers.ts`).

Call `resetTestData()` between test files — this calls `POST /api/test/reset`, which is only available when `OPENTASK_TEST_MODE=1`.

Helpers: `tests/integration/helpers.ts`, `tests/integration/globalSetup.ts`

### E2E tests

Location: `tests/e2e/`

Playwright with headless Chromium. Uses separate DB (`data/test-e2e.db`). The `authenticatedPage` fixture provides a pre-logged-in browser page by logging in via the real login form.

Helpers: `tests/e2e/fixtures.ts`, `tests/e2e/globalSetup.ts`

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

### Handling unsaved-changes dialogs in Playwright

The task detail page (and any page with QuickActionPanel) has a `beforeunload` handler that triggers a browser "Leave site?" confirmation dialog when there are unsaved changes. When using Playwright for browser testing:

1. Reset dirty state first: Click "Reset" or "Cancel" before navigating away
2. Or handle the dialog: Use `mcp__playwright__browser_handle_dialog` with `accept: true` to dismiss the dialog and proceed

## Deployment

**Local development:** `npm run dev` starts a hot-reloading server on port 3000.

**Production deployment:** OpenTask uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory. Deploy the built output however you prefer — systemd service, Docker, etc. Schema migrations run automatically on app startup.

**Commit policy for deployments** (overrides the global "only commit when explicitly instructed" rule):

- **Production deploy**: Commit all changes first — rollback depends on checking out a previous commit
- **Iterative dev deploys** (during UI verification): Commits not required between deploys
- **Final dev deploy** (after verification): Commit the verified version, then re-deploy from the clean commit
- If there are uncommitted changes and you need to deploy, ask the user to confirm a commit first

**Rollback:** Prefer `git revert HEAD` (creates a new commit, preserves history). Only use `git checkout <sha>` if you need to roll back multiple commits.

**Database inspection:** `sqlite3 data/tasks.db` for the local database.

See `CLAUDE.local.md` (gitignored) for environment-specific deployment details (server addresses, service names, deploy scripts, etc.).

### Demo User

The demo account showcases OpenTask with curated portfolio-style tasks. User isolation is via `user_id` filtering.

| Setting       | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Username      | `demo`                                                      |
| Password      | `demo` (shown on login page when `NEXT_PUBLIC_DEMO_MODE=1`) |
| Notifications | Disabled                                                    |
| Daily reset   | Yes (via cron)                                              |
| Projects      | Inbox, Client Work, Try It                                  |

**Scripts:**

- `npm run db:seed-demo` — Create the demo user and ~55 tasks (run once)
- `npm run db:reset-demo` — Delete and re-create all demo data (daily cron)

### Security Hardening

- **API tokens**: Stored as SHA-256 hashes. The `token` column in `api_tokens` holds the hash; `token_preview` stores the last 8 chars of the raw token for UI display. Raw token is shown once at creation.
- **Login rate limiting**: In-memory, 5 failures per username in 15 min triggers lockout with exponential backoff (30s, 60s, 120s...).
- **Security headers**: Set in `next.config.ts` and your reverse proxy config: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **JWT sessions**: `maxAge` set to 7 days (default was 30).

## iOS App (`ios/`)

Native iOS companion app — a thin SwiftUI wrapper (iOS 17+) that hosts the PWA in a WKWebView and adds APNs push notifications. All task data and business logic live on the server; the app stores no local data beyond connection credentials.

**Three targets:**

- `OpenTask` — Main app: WKWebView host, first-launch setup (server URL + Bearer token), APNs device registration, notification action handling, silent-push dismissal for cross-device sync
- `OpenTaskNotification` — Content extension: interactive snooze grid on notification long-press, direct API calls for snooze/done without forwarding to the main app
- `OpenTaskWatch` — watchOS companion (watchOS 10+): handles notification actions (Done/Snooze) directly on Apple Watch instead of forwarding to iPhone. Reads credentials from shared App Group keychain — no setup UI needed. Provides haptic feedback on success/failure.

**Shared code** (`Shared/`): `APIClient.swift` (HTTP with Bearer auth), `KeychainHelper.swift` (App Group keychain for credential sharing between app, extension, and Watch app), `DateHelpers.swift` (ISO 8601, snap-to-preset, delta formatting). All shared code uses only `Foundation`/`Security` — no platform-specific imports, compiles on both iOS and watchOS.

**Build:** xcodegen generates `.xcodeproj` from `project.yml`. Regenerate with `cd ios && xcodegen` after changing `project.yml`.

**Server API endpoints used by the iOS app:**

- `POST /api/push/apns/register` — device token registration
- `POST /api/notifications/actions` — done/snooze from notification actions
- `PATCH /api/tasks/{id}` — snooze to specific time (content extension)
- `POST /api/tasks/bulk/snooze-overdue` — bulk snooze from notification action
- `DELETE /api/push/apns/register` — device token unregistration
- `GET /api/user/preferences` — connection validation during setup

**No automated tests** — the iOS app has no test targets. Testing is manual.

### Notification phases

1. **Default actions** (AppDelegate): Done, +1hr, All +1hr buttons — used from lock screen or when content extension is unavailable
2. **Silent dismissal**: Server sends `content-available: 1` push with `type: "dismiss"` when a task is snoozed/completed from the web UI — iOS app removes matching delivered notifications
3. **Content extension** (long-press): Interactive 3x4 snooze grid (presets, increments, decrements) — extension makes API calls directly and dismisses

### Simulator limitations

- **Notification content extensions cannot be tested in the simulator.** Long-press expansion is a known Apple limitation across all Xcode versions. Use a physical device.
- **watchOS notification actions cannot be tested in the simulator.** Mirrored notifications and action forwarding require a physical iPhone + Apple Watch pair.
- `xcrun simctl push` delivers banners but does not invoke service or content extensions.
- iOS 18.2 simulator: apps don't appear in Settings (known bug, fixed in 18.4+).

### Physical device caution

- **Avoid `devicectl device process launch` on the user's phone** unless specifically needed. It kills the running app process, which can reset app state and force the user to re-enter credentials. Prefer letting the user launch the app themselves after install.
- **`install_app_device` (XcodeBuildMCP) / `devicectl device install app` is safe** — it replaces the binary without losing Keychain data or app state.

### XcodeBuildMCP tips

XcodeBuildMCP is an MCP tool server for building and interacting with iOS simulators and devices from Claude Code.

- On iOS 26+, use `touch` (down+up) instead of `tap` to focus SwiftUI text fields — `tap` doesn't reliably activate them.
- WKWebView content is not exposed in the accessibility tree. Use screenshot coordinates for web view interactions.
- **watchOS device builds**: XcodeBuildMCP's `build_device` and `install_app_device` don't work reliably for watchOS targets (hardcoded to iOS platform, install reports success but app isn't actually installed). Use xcodebuild and devicectl directly instead:
  - Build: `xcodebuild -project OpenTask.xcodeproj -scheme OpenTaskWatch -destination 'platform=watchOS,id=DEVICE_ID' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build`
  - Get the Watch device ID: `xcodebuild -scheme OpenTaskWatch -showdestinations` (different from the UDID in `list_devices`)
  - Install: `xcrun devicectl device install app --device WATCH_UDID path/to/OpenTaskWatch.app`
  - Launch: `xcrun devicectl device process launch --device WATCH_UDID io.mcnitt.opentask.watchapp`
  - Verify: `xcrun devicectl device info apps --device WATCH_UDID | grep opentask`
