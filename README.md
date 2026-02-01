# OpenTask

A self-hosted, multi-user task management system designed for AI-assisted daily workflow management. Built with Next.js and SQLite, optimized for programmatic control by Claude Code while providing a polished web UI.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Database:** SQLite with WAL mode (better-sqlite3)
- **Authentication:** NextAuth/Auth.js (credentials provider)
- **Recurrence:** rrule.js with Luxon for timezone-aware scheduling
- **Styling:** Tailwind CSS
- **Testing:** Vitest (unit/integration), Playwright (E2E)

## Features

- First-class recurring tasks with RFC 5545 RRULE support
- Anti-drift recurrence computation (tasks always land on correct day/time)
- Snooze with original due date preservation
- Multi-step undo/redo with surgical field restoration
- Soft delete (trash) and archive
- Multi-user with shared projects
- PWA installable on iOS/Android

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
# Clone the repository
git clone ssh://git@git.tk11.mcnitt.io:2222/trent/opentask.git
cd opentask

# Install dependencies
npm install

# Copy environment template and configure
cp .env.example .env.local
# Edit .env.local with your settings

# Seed the database with initial users and projects
npm run db:seed

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

See `.env.example` for required configuration:

- `AUTH_SECRET` - NextAuth secret key
- `OPENTASK_DB_PATH` - SQLite database path (optional, defaults to `./data/tasks.db`)

## Available Scripts

| Script                  | Description                              |
| ----------------------- | ---------------------------------------- |
| `npm run dev`           | Start development server with hot reload |
| `npm run build`         | Build for production                     |
| `npm run start`         | Start production server                  |
| `npm run lint`          | Run ESLint                               |
| `npm test`              | Run unit and integration tests           |
| `npm run test:watch`    | Run tests in watch mode                  |
| `npm run test:coverage` | Run tests with coverage report           |
| `npm run test:e2e`      | Run Playwright E2E tests                 |
| `npm run db:seed`       | Seed database with initial data          |

## API Overview

### Authentication

- Session-based auth via NextAuth (web UI)
- Bearer token auth for API/CLI access

### Key Endpoints

| Endpoint                 | Method   | Description                    |
| ------------------------ | -------- | ------------------------------ |
| `/api/tasks`             | GET      | List tasks with filters        |
| `/api/tasks`             | POST     | Create a task                  |
| `/api/tasks/:id`         | PATCH    | Update task (PATCH semantics)  |
| `/api/tasks/:id`         | DELETE   | Soft delete to trash           |
| `/api/tasks/:id/done`    | POST     | Mark done (advances recurring) |
| `/api/tasks/:id/snooze`  | POST     | Snooze to future time          |
| `/api/tasks/bulk/done`   | POST     | Bulk mark done                 |
| `/api/tasks/bulk/snooze` | POST     | Bulk snooze                    |
| `/api/undo`              | POST     | Undo last action               |
| `/api/redo`              | POST     | Redo last undone action        |
| `/api/projects`          | GET/POST | List/create projects           |

See `docs/SPEC.md` for complete API documentation.

## Project Structure

```
src/
├── app/                 # Next.js App Router pages and API routes
│   ├── api/            # REST API endpoints
│   └── login/          # Auth pages
├── components/         # React components
├── core/               # Business logic
│   ├── auth/          # Authentication
│   ├── db/            # Database access
│   ├── recurrence/    # RRULE computation
│   ├── tasks/         # Task CRUD operations
│   ├── undo/          # Undo/redo engine
│   └── validation/    # Zod schemas
├── lib/               # Utilities
└── types/             # TypeScript types
tests/
├── behavioral/        # Spec-linked tests (RD-*, SN-*, etc.)
└── helpers/           # Test utilities
```

## Development

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# E2E tests (requires dev server running)
npm run test:e2e
```

### Database

SQLite database is stored at `data/tasks.db` by default. To reset:

```bash
rm -rf data/tasks.db*
npm run db:seed
```

## Deployment

Deployed on `tk11.mcnitt.io` as a systemd service. See `docs/SPEC.md` for deployment details.

## License

Private - All rights reserved.
