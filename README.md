<p align="center">
  <img src="public/opentask-sun-logo.png" alt="OpenTask" width="128">
</p>

<p align="center">
  <img src="public/opentask-text-logo.png" alt="OpenTask" width="400">
</p>

<p align="center">
  <strong>A self-hosted task manager where due dates are reminders, not deadlines.</strong><br>
  Snooze-first workflow. Single container. Your data, your server.
</p>

<p align="center">
  <a href="https://opentask.mcnitt.io"><img src="https://img.shields.io/badge/Live_Demo-opentask.mcnitt.io-ff69b4" alt="Live Demo"></a>
  <a href="https://github.com/trentmcnitt/opentask/pkgs/container/opentask"><img src="https://img.shields.io/badge/Docker-ghcr.io-blue" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green.svg" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://opentask.mcnitt.io">Try the Demo</a> · <a href="docs/SPEC.md">Documentation</a> · <a href="docs/AUTOMATION.md">API Guide</a> · <a href="docs/ROADMAP.md">Roadmap</a>
</p>

## Why OpenTask?

Most task managers treat due dates as deadlines. OpenTask treats them as reminders.

Wake up with 15 overdue tasks from yesterday? Tap the bulk snooze button — they all move forward an hour. Work through a few, snooze the rest again later. A task snoozed five times in one day and completed that evening is a success, not a failure.

Only tasks you mark as urgent are true deadlines — they're excluded from bulk snooze and must be handled individually. Everything else is fair game for triage.

If you've used Todoist or Things and wished you could self-host it with push notifications that actually work, this might be for you.

**What makes it different:**

- **Snooze-centric workflow.** Bulk snooze all overdue tasks in one tap. The snooze button lives in the top bar — it's the most prominent action in the app, because you'll use it dozens of times a day.
- **Personal task management, not project management.** This isn't trying to be Jira or Trello. It's a fast, focused tool for managing your own tasks.
- **Single container, no external services.** SQLite with WAL mode. No Postgres, no Redis, no separate database to manage. Back up your data by copying one file.
- **Mobile-first PWA.** Installable on iOS and Android. Not a desktop app with a responsive afterthought.
- **Native iOS companion app.** Real push notifications with interactive snooze actions, including Apple Watch support. No CalDAV workarounds.
- **Full undo/redo.** Every action is logged and reversible. Soft-delete everything.
- **REST API with Bearer token auth.** Script it, automate it, pipe it into Apple Shortcuts. [OpenAPI spec](docs/AUTOMATION.md#openapi-specification) included.
- **Webhooks.** HTTP callbacks on task events with HMAC-SHA256 signing. Integrate with n8n, Home Assistant, Node-RED, or anything that accepts webhooks.
- **Data export.** JSON and CSV export of all your data — tasks, projects, and completions. Your data is always portable.
- **Reverse proxy auth.** Works with Authelia, Authentik, and other auth proxies out of the box.
- **Optional AI enrichment.** Type "call dentist next tuesday high priority" and AI parses it into a structured task. Daily insights surface forgotten tasks. Works with any OpenAI-compatible API — fully optional, the app works great without it.

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
OPENTASK_INIT_TIMEZONE=America/New_York
EOF

docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) and log in with the username and password you set above. The initial user and database are created automatically on first start.

### Updating

```bash
docker compose pull
docker compose up -d
```

Your data is stored in `./data/` and persists across updates. Store this directory on a local filesystem — network mounts (NFS, CIFS) are not compatible with SQLite's file locking.

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
| `AUTH_URL`            | No       | Public URL when behind a reverse proxy              |
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

### Reverse Proxy Header Auth (Optional)

If you run an auth proxy like [Authelia](https://www.authelia.com/), [Authentik](https://goauthentik.io/), or Caddy's `forward_auth`, OpenTask can trust the authenticated username from a request header — no separate login required.

Set the `OPENTASK_PROXY_AUTH_HEADER` environment variable to the header name your proxy uses:

```yaml
# docker-compose.yml
environment:
  OPENTASK_PROXY_AUTH_HEADER: Remote-User # or X-Forwarded-User, X-Auth-User, etc.
```

The header value must match an existing OpenTask username (case-insensitive). Users are not auto-created — create them first with `scripts/create-user.ts`.

> **Security:** Your reverse proxy **must** strip this header from external requests before forwarding. If external clients can set this header directly, they can authenticate as any user. This is standard practice for Authelia/Authentik deployments but worth verifying.

### Push Notifications (Optional)

- **Web Push:** Generate VAPID keys with `npx web-push generate-vapid-keys` and set them in your environment. Works on all platforms including iOS Safari.
- **iOS Native Push (APNs):** Requires the iOS companion app and an Apple Developer Program membership. See `.env.example` for the configuration variables.

### AI Features (Optional)

AI is entirely optional. When disabled (the default), all AI UI elements are hidden and no AI code runs. The app stands on its own as a fast task manager.

When enabled, AI provides:

- **Task enrichment** — Natural language parsing into structured tasks with title, due date, priority, labels, and project
- **Quick Take** — One-liner contextual commentary when you add a task
- **What's Next** — Recommendations surfacing overlooked or forgotten tasks
- **Insights** — Scoring and signals (stale, quick win, etc.) to help prioritize

Three provider options:

| Provider              | Setup                                                                               | Best for                                             |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Claude Code (SDK)** | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on the server | Development, Max subscription users                  |
| **Anthropic API**     | Set `ANTHROPIC_API_KEY`                                                             | Production with Anthropic models                     |
| **OpenAI-compatible** | Set `OPENAI_API_KEY` + `OPENAI_MODEL`                                               | OpenAI, xAI/Grok, OpenRouter, DeepSeek, Ollama, etc. |

Tested with Claude Sonnet 4.6, GPT-4.1-mini, Grok 4.1 Fast, and DeepSeek V3. Any provider with an OpenAI-compatible chat completions endpoint should work — see `.env.example` for configuration details and quick-start examples.

## API

Three auth methods, checked in order:

1. **Bearer token** — For scripts and automation. Create with: `npm run db:create-token -- <username> [name]`
2. **Proxy header** — For reverse proxy auth (Authelia, Authentik). See [Reverse Proxy Header Auth](#reverse-proxy-header-auth-optional).
3. **Session cookie** — For the web UI (managed automatically)

Key endpoints:

| Endpoint                         | Method   | Description                      |
| -------------------------------- | -------- | -------------------------------- |
| `/api/tasks`                     | GET      | List tasks with filters          |
| `/api/tasks`                     | POST     | Create a task                    |
| `/api/tasks/:id`                 | PATCH    | Update task fields               |
| `/api/tasks/:id`                 | DELETE   | Soft delete to trash             |
| `/api/tasks/:id/done`            | POST     | Mark done (advances recurring)   |
| `/api/tasks/:id/snooze`          | POST     | Snooze to future time            |
| `/api/tasks/bulk/snooze-overdue` | POST     | One-tap snooze all overdue tasks |
| `/api/tasks/bulk/done`           | POST     | Bulk mark done                   |
| `/api/tasks/bulk/snooze`         | POST     | Bulk snooze by task IDs          |
| `/api/undo`                      | POST     | Undo last action                 |
| `/api/redo`                      | POST     | Redo last undone action          |
| `/api/projects`                  | GET/POST | List/create projects             |
| `/api/export`                    | GET      | Export data (JSON or CSV)        |
| `/api/webhooks`                  | GET/POST | List/create webhooks             |
| `/api/openapi`                   | GET      | OpenAPI 3.1 spec (no auth)       |

See [docs/AUTOMATION.md](docs/AUTOMATION.md) for the full API reference, webhook setup, curl examples, and Apple Shortcuts integration.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. Quick setup:

```bash
git clone https://github.com/trentmcnitt/opentask.git
cd opentask
npm install
cp .env.example .env.local
echo 'AUTH_SECRET=dev-secret-change-me' >> .env.local
npm run db:seed-dev
npm run dev
# Open http://localhost:3000 — login: dev / dev
```

[AGENTS.md](AGENTS.md) has detailed development conventions for AI-assisted development.

## License

[AGPL-3.0](LICENSE)
