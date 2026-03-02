# Contributing to OpenTask

## Prerequisites

- Node.js 20+
- npm

## Quick Setup

```bash
git clone https://github.com/trentmcnitt/opentask.git
cd opentask
npm install
cp .env.example .env.local
echo 'AUTH_SECRET=dev-secret-change-me' >> .env.local
npm run db:seed-dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and login with username `dev`, password `dev`.

The dev seed creates ~25 tasks across 4 projects with overdue items, recurring tasks, multiple priorities, labels, archived tasks, and a trashed task — enough to see every feature working.

## Running Tests

```bash
# Quick check — run after every change
npm run type-check && npm run lint && npm test

# Integration tests (HTTP API)
npm run test:integration

# E2E tests (browser)
npx playwright install chromium   # first time only
npm run test:e2e
```

### What to run when

| Change type                  | What to run                              |
| ---------------------------- | ---------------------------------------- |
| Every change                 | Quick check                              |
| API routes, core logic, auth | Quick check + `npm run test:integration` |
| UI components, hooks, styles | Quick check + `npm run test:e2e`         |
| Refactoring                  | All test suites                          |

AI quality tests (`npm run test:quality`) require `OPENTASK_AI_ENABLED=true` and are only needed when modifying AI prompts or enrichment logic.

## Code Conventions

- **Import alias:** `@/` maps to `src/`
- **Naming:** Components are PascalCase (`TaskRow.tsx`), other files are kebab-case (`api-response.ts`)
- **Dates:** Stored as UTC in the database, converted to user timezone in API responses and UI
- **Updates:** Use PATCH, not PUT — handlers update only fields present in the request body
- **Mutations:** Every task mutation must be atomic and logged for undo (see AGENTS.md for the pattern)
- **Deletions:** Always soft-delete (`deleted_at`). Only "Empty Trash" hard-deletes.
- **Lint:** Never suppress lint errors with `eslint-disable` or `@ts-ignore` — fix the root cause
- **Formatting:** Prettier runs automatically via pre-commit hook. Run `npm run format` to fix formatting manually.

## Project Structure

```
src/
├── app/              # Next.js pages and API routes
├── components/       # React components
├── core/             # Business logic (auth, db, tasks, recurrence, undo, ai)
├── hooks/            # Custom React hooks
├── lib/              # Utilities
└── types/            # TypeScript types
tests/
├── behavioral/       # Core logic tests (no HTTP)
├── integration/      # HTTP API tests
├── e2e/              # Playwright browser tests
└── quality/          # AI prompt quality tests
```

See [AGENTS.md](AGENTS.md) for detailed architecture docs, API patterns, undo system, recurrence model, and testing conventions.

## Environment Variables

Only `AUTH_SECRET` is required for local development. Everything else has sensible defaults or is optional. See `.env.example` for the full list — variables are grouped by category with clear labels for what's required vs. production-only.

## Submitting Changes

1. Branch from `main`
2. Make your changes
3. Run the quick check: `npm run type-check && npm run lint && npm test`
4. Run additional test suites if your change affects API routes or UI (see table above)
5. Open a PR with a clear description of what changed and why
6. For UI changes, include before/after screenshots

## AI-Assisted Development

This project uses [AGENTS.md](AGENTS.md) for AI-assisted development. If you use Claude Code, Codex, Cursor, Copilot, or similar AI tools, AGENTS.md provides detailed conventions, patterns, and anti-patterns that help the AI produce correct code for this codebase.
