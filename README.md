# OpenTask

A self-hosted task manager built for personal use. Next.js + SQLite — one container, no external database.

<!-- TODO: Add hero screenshot showing desktop dashboard with demo data -->
<!-- ![OpenTask dashboard](docs/screenshots/desktop-dashboard.png) -->

[Live Demo](https://opentask.mcnitt.io) · [Documentation](docs/SPEC.md) · [API Guide](docs/AUTOMATION.md)

## Why OpenTask?

I built OpenTask because I wanted a task manager that works the way I think about tasks — most due dates are reminders, not deadlines. Snoozing a low-priority task five times isn't procrastination, it's triage.

If you've used Todoist or Things and wished you could self-host it with push notifications that actually work, this might be for you.

**What makes it different from Vikunja, Planka, etc.:**

- **Single container, zero dependencies.** SQLite with WAL mode. No Postgres, no Redis, no external database to manage. Back up your data by copying one file.
- **Mobile-first PWA.** Installable on iOS and Android. Not a desktop app with a responsive afterthought.
- **Native iOS companion app.** Real push notifications with interactive snooze actions, including Apple Watch support. No CalDAV workarounds.
- **Personal task management, not project management.** This isn't trying to be Jira or Trello. It's a fast, focused tool for managing your own tasks.
- **Snooze-centric workflow.** Bulk snooze overdue tasks in one tap. Due dates on most tasks are reminders — the system is built around that.
- **Full undo/redo.** Every action is logged and reversible. Soft-delete everything.
- **REST API with Bearer token auth.** Script it, automate it, pipe it into Apple Shortcuts.
- **Optional AI enrichment.** Type "call dentist next tuesday high priority" and AI parses it into a structured task. Daily insights surface forgotten tasks. AI features require Claude Code on the server but are fully optional — the app works great without them.

## Quick Start (Docker)

```bash
# Create a directory for OpenTask
mkdir opentask && cd opentask

# Download the compose file
curl -O https://raw.githubusercontent.com/trentmcnitt/opentask/main/docker-compose.yml

# Generate a secret key and start the app
cat > .env <<EOF
AUTH_SECRET=$(openssl rand -base64 32)
OPENTASK_INIT_USERNAME=admin
OPENTASK_INIT_PASSWORD=changeme
EOF

docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) and login with the username and password you set above. The initial user and database are created automatically on first start.

### Updating

```bash
docker compose pull
docker compose up -d
```

Your data is stored in `./data/` and persists across updates.

### Backup

SQLite makes backups simple. Use the built-in `.backup` command for a safe, consistent copy (it handles WAL mode correctly):

```bash
# From the host (recommended)
docker compose exec opentask sqlite3 /app/data/tasks.db '.backup /app/data/backup.db'
cp data/backup.db /path/to/your/backups/tasks-$(date +%F).db

# Or stop the container first, then copy directly
docker compose stop
cp data/tasks.db /path/to/your/backups/
docker compose start
```

> **Note:** SQLite uses WAL (write-ahead logging), so `tasks.db-wal` and `tasks.db-shm` files may exist alongside the main database. A plain `cp tasks.db` while the app is running could produce an inconsistent backup. The `sqlite3 .backup` command avoids this.

### Additional Users

Create more users from the command line:

```bash
# Docker
docker compose exec opentask tsx scripts/create-user.ts <username> <password>

# Bare metal
npx tsx scripts/create-user.ts <username> <password> [email] [timezone]
```

### API Tokens

Create a Bearer token for API access and automation:

```bash
# Docker
docker compose exec opentask tsx scripts/create-token.ts <username> [token-name]

# Bare metal
npm run db:create-token -- <username> [token-name]
```

## Manual Installation (without Docker)

Requires Node.js 20+ and npm.

```bash
git clone https://github.com/trentmcnitt/opentask.git
cd opentask
npm install

# Configure
cp .env.example .env.local
# Edit .env.local — at minimum, set AUTH_SECRET (openssl rand -base64 32)

# Create your user
npx tsx scripts/create-user.ts admin changeme

# Build and start
npm run build
npm run start
```

For development: `npm run dev` starts a hot-reloading server on port 3000.

## Configuration

See `.env.example` for all options. The essentials:

| Variable              | Required | Description                                         |
| --------------------- | -------- | --------------------------------------------------- |
| `AUTH_SECRET`         | Yes      | Secret key for sessions (`openssl rand -base64 32`) |
| `OPENTASK_DB_PATH`    | No       | SQLite database path (default: `./data/tasks.db`)   |
| `OPENTASK_AI_ENABLED` | No       | Enable AI features (default: `false`)               |

Login is **username-based**, not email-based.

### Reverse Proxy

OpenTask runs on port 3000 by default. Set `AUTH_URL` to your public URL in the compose environment when using a reverse proxy.

**Caddy:**

```
tasks.example.com {
    reverse_proxy localhost:3000
}
```

**Nginx:**

```nginx
server {
    server_name tasks.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for Server-Sent Events (SSE)
        proxy_buffering off;
        proxy_cache off;
    }
}
```

> **Note:** OpenTask uses Server-Sent Events for real-time updates. Make sure your reverse proxy does not buffer responses — Caddy handles this automatically, but Nginx needs `proxy_buffering off`.

### Push Notifications (Optional)

- **Web Push:** Generate VAPID keys with `npx web-push generate-vapid-keys` and set them in your environment. Works on all platforms including iOS Safari.
- **iOS Native Push (APNs):** Requires the iOS companion app and an Apple Developer Program membership. See `.env.example` for the configuration variables.

### AI Features (Optional)

AI is entirely optional. When disabled (the default), all AI UI elements are hidden and no AI code runs. The app stands on its own as a fast task manager.

When enabled, AI provides:

- **Task enrichment** — Natural language parsing into structured tasks with title, due date, priority, labels, and project
- **What's Next** — Recommendations surfacing overlooked or forgotten tasks
- **Insights** — Scoring and signals (stale, quick win, etc.) to help prioritize

AI currently requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated on the server. Direct API key support is planned.

## Screenshots

<!-- TODO: Replace with actual screenshots from demo account -->
<!-- Desktop and mobile views side by side -->
<!--
![Desktop dashboard](docs/screenshots/desktop-dashboard.png)
![Mobile view](docs/screenshots/mobile-dashboard.png)
![Task detail](docs/screenshots/task-detail.png)
-->

_Screenshots coming soon. In the meantime, try the [live demo](https://opentask.mcnitt.io)._

## API

Two auth methods, checked in order:

1. **Bearer token** — For scripts and automation. Create with: `npm run db:create-token -- <username> [name]`
2. **Session cookie** — For the web UI (managed automatically)

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

See [docs/AUTOMATION.md](docs/AUTOMATION.md) for curl examples and Apple Shortcuts integration.

## Tech Stack

- **Runtime:** Next.js 16 (App Router) + React 19 + TypeScript
- **Database:** SQLite with WAL mode (better-sqlite3) — no external database
- **Auth:** NextAuth/Auth.js (credentials provider, JWT sessions)
- **Styling:** Tailwind CSS 4 + Shadcn UI
- **Testing:** Vitest (behavioral + integration) + Playwright (E2E)

## Project Structure

```
src/
├── app/              # Next.js pages and API routes
├── components/       # React components
├── core/             # Business logic (auth, db, tasks, recurrence, undo, ai)
├── hooks/            # Custom React hooks
├── lib/              # Utilities
└── types/            # TypeScript types
ios/                  # Native iOS companion app (SwiftUI + WKWebView)
tests/                # Behavioral, integration, E2E, and AI quality tests
docs/                 # Product spec, design rationale, API guide, roadmap
```

## Contributing

See `CLAUDE.md` for development conventions, coding standards, and the full test matrix.

```bash
# Quick check (run after every change)
npm run type-check && npm run lint && npm test

# Full test suite
npm run test:integration  # HTTP API tests
npm run test:e2e          # Playwright browser tests
```

## License

[AGPL-3.0](LICENSE)
