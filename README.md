# OpenTask

A self-hosted, AI-powered task management app. Built with Next.js and SQLite, designed as a mobile-first PWA with a native iOS companion app.

Type "call dentist next tuesday high priority" and AI parses it into a structured task with the right title, due date, priority, and project. Daily insights surface forgotten tasks. What's Next tells you what to focus on. AI features are built in and require no external service beyond a Claude subscription — but they're also fully optional if you just want a clean, fast task manager.

OpenTask is opinionated: it treats most due dates as reminders rather than deadlines, supports full undo/redo for every action, and soft-deletes everything. See [Due Date Philosophy](docs/DESIGN.md) for the rationale.

## Features

- **Recurring tasks** — RFC 5545 RRULE support with anti-drift timezone-aware scheduling
- **Snooze** — Bulk or individual, with original due date preservation
- **Undo/redo** — Multi-step, surgical field restoration for every action
- **Projects** — Personal and shared, with multi-user support
- **Soft delete** — Trash and archive with retention policies
- **PWA** — Installable on iOS and Android with offline shell caching
- **iOS app** — Native companion app with push notifications and interactive snooze actions (see `ios/`)
- **API-first** — Full REST API with Bearer token auth for scripting and automation (see [docs/AUTOMATION.md](docs/AUTOMATION.md))
- **AI-powered task entry** — Natural language parsing, daily insights, and "What's Next" recommendations (optional — works great without AI too)

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Database:** SQLite with WAL mode (better-sqlite3)
- **Auth:** NextAuth/Auth.js (credentials provider, JWT sessions)
- **Styling:** Tailwind CSS 4 + Shadcn UI
- **Testing:** Vitest (behavioral/integration) + Playwright (E2E)

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
git clone https://github.com/yourusername/opentask.git
cd opentask

# Install dependencies
npm install

# Copy environment template and configure
cp .env.example .env.local
# Edit .env.local — at minimum, set AUTH_SECRET

# Seed the database with initial users and projects
npm run db:seed

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

See `.env.example` for the full list. The essentials:

| Variable              | Required | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| `AUTH_SECRET`         | Yes      | NextAuth secret key (`openssl rand -base64 32`) |
| `OPENTASK_DB_PATH`    | No       | SQLite path (default: `./data/tasks.db`)        |
| `OPENTASK_AI_ENABLED` | No       | Enable AI features (default: `false`)           |

### Login

Login is **username-based**, not email-based. After running `npm run db:seed`, check the seed output for the default credentials, or look at `.secrets` if present.

## AI Features

AI is a first-class part of OpenTask, but entirely optional. When `OPENTASK_AI_ENABLED=false` (the default), all AI UI elements are hidden and no AI-related code runs. The app stands on its own as a fast, keyboard-driven task manager.

When enabled, AI provides:

- **Task enrichment** — Type "call dentist next tuesday high priority" and AI parses it into a structured task with title, due date, priority, labels, and project
- **What's Next** — Daily recommendations surfacing overlooked or forgotten tasks
- **Insights** — Scoring and signals (stale, quick win, etc.) to help prioritize

### Requirements

AI features currently require **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated on the server. This means the machine running OpenTask needs:

1. Claude Code installed globally (`npm install -g @anthropic-ai/claude-code`)
2. An active Claude subscription (Pro or Max) authenticated via `claude` CLI

There is no API key to configure — the app uses the Claude Agent SDK, which leverages your existing Claude Code authentication.

> **Note:** Direct Anthropic API support (bring your own API key) is not yet implemented but is planned. This would remove the Claude Code dependency for AI features.

### AI Configuration

```bash
# Enable AI
OPENTASK_AI_ENABLED=true

# Per-feature model selection (defaults shown)
OPENTASK_AI_ENRICHMENT_MODEL=haiku
OPENTASK_AI_INSIGHTS_MODEL=claude-opus-4-6
OPENTASK_AI_WHATS_NEXT_MODEL=claude-opus-4-6
```

See `.env.example` for all AI-related options (concurrency, timeouts, model selection, retention).

## Available Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run dev`              | Start development server with hot reload      |
| `npm run build`            | Build for production (standalone output)      |
| `npm run start`            | Start production server                       |
| `npm run lint`             | Run ESLint                                    |
| `npm run type-check`       | TypeScript type checking                      |
| `npm run format`           | Prettier format all files                     |
| `npm test`                 | Run behavioral tests (Vitest)                 |
| `npm run test:integration` | Integration tests (HTTP against built server) |
| `npm run test:e2e`         | Playwright E2E tests                          |
| `npm run db:seed`          | Seed database with initial users and projects |
| `npm run db:seed-dev`      | Seed dev database with ~80 realistic tasks    |

## API Overview

### Authentication

Two methods, checked in order:

1. **Bearer token** — For API/CLI/automation access. Create tokens with `npm run db:create-token -- <username> [name]`
2. **Session cookie** — For web UI (managed by NextAuth)

If a Bearer token is present but invalid, the request is rejected immediately (never falls through to session auth).

### Key Endpoints

| Endpoint                 | Method   | Description                    |
| ------------------------ | -------- | ------------------------------ |
| `/api/tasks`             | GET      | List tasks with filters        |
| `/api/tasks`             | POST     | Create a task                  |
| `/api/tasks/:id`         | PATCH    | Update task fields             |
| `/api/tasks/:id`         | DELETE   | Soft delete to trash           |
| `/api/tasks/:id/done`    | POST     | Mark done (advances recurring) |
| `/api/tasks/:id/snooze`  | POST     | Snooze to future time          |
| `/api/tasks/bulk/done`   | POST     | Bulk mark done                 |
| `/api/tasks/bulk/snooze` | POST     | Bulk snooze                    |
| `/api/undo`              | POST     | Undo last action               |
| `/api/redo`              | POST     | Redo last undone action        |
| `/api/projects`          | GET/POST | List/create projects           |

See [docs/AUTOMATION.md](docs/AUTOMATION.md) for usage examples with curl and Apple Shortcuts.

## Project Structure

```
src/
├── app/                 # Next.js App Router pages and API routes
├── components/          # React components
├── core/                # Business logic (no UI)
│   ├── ai/             # AI integration (enrichment, insights, what's next)
│   ├── auth/           # Authentication
│   ├── db/             # Database access and schema
│   ├── recurrence/     # RRULE computation
│   ├── tasks/          # Task CRUD operations
│   ├── undo/           # Undo/redo engine
│   └── validation/     # Zod schemas
├── hooks/              # Custom React hooks
├── lib/                # Utilities
└── types/              # TypeScript types
ios/                     # Native iOS companion app (SwiftUI + WKWebView)
tests/
├── behavioral/          # Core logic tests
├── integration/         # HTTP API tests
├── e2e/                 # Playwright browser tests
└── quality/             # AI prompt quality tests
docs/
├── SPEC.md              # Full product specification
├── AI.md                # AI integration design document
├── AUTOMATION.md        # External API integration guide
├── DESIGN.md            # Design rationale (due dates, priorities)
└── ROADMAP.md           # Feature ideas under consideration
```

## Database

SQLite with WAL mode, stored at `data/tasks.db` by default. Schema is applied idempotently on startup — no manual migration step needed.

To reset the database:

```bash
rm -rf data/tasks.db*
npm run db:seed
```

## Deployment

OpenTask uses Next.js standalone output mode, which bundles the server and dependencies into a self-contained directory. A deploy script handles building locally and rsyncing to the server.

```bash
# Build and deploy
./scripts/deploy.sh <target>
```

The target server needs Node.js 20+ and a systemd service (or equivalent) to run the app. See the deploy script for details.

### Push Notifications (Optional)

- **Web Push:** Requires VAPID keys (`npx web-push generate-vapid-keys`). Works on all platforms including iOS Safari.
- **iOS Native Push (APNs):** Requires the iOS companion app, an Apple Developer Program membership ($99/year), and a p8 key. See `.env.example` for configuration.

## Development

### Running Tests

```bash
# Quick check (run after every change)
npm run type-check && npm run lint && npm test

# Integration tests (tests HTTP API against built server)
npm run test:integration

# E2E tests (Playwright, headless Chromium)
npm run test:e2e

# AI quality tests (requires OPENTASK_AI_ENABLED=true)
npm run test:quality
```

### Contributing

See `CLAUDE.md` for detailed development conventions, coding standards, and the full test matrix.

## License

MIT License — see [LICENSE](LICENSE) for details.
