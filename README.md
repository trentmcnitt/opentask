<p align="center">
  <img src="public/opentask-sun-logo.png" alt="OpenTask" width="128">
</p>

<p align="center">
  <img src="public/opentask-text-logo.png" alt="OpenTask" width="400">
</p>

<p align="center">
  <strong>A self-hosted, AI-powered task and habit manager for web, iPhone, Apple Watch, and Mac.</strong><br>
  Single container. SQLite. Your data, your server.
</p>

<p align="center">
  <a href="https://opentask.mcnitt.io"><img src="https://img.shields.io/badge/Live_Demo-opentask.mcnitt.io-ff69b4" alt="Live Demo"></a>
  <a href="https://github.com/trentmcnitt/opentask/pkgs/container/opentask"><img src="https://img.shields.io/badge/Docker-ghcr.io-blue" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-green.svg" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://opentask.mcnitt.io">Try the Demo</a> · <a href="https://opentask.mcnitt.io/docs/">Documentation</a> · <a href="https://opentask.mcnitt.io/docs/api/">API Reference</a> · <a href="https://opentask.mcnitt.io/docs/roadmap">Roadmap</a>
</p>

<p align="center">
  🌐 Web (PWA) · 📱 iOS (native, with widgets) · ⌚ Apple Watch · 💻 Mac · 🔌 REST API · OpenAPI 3.1
</p>

<p align="center">
  <img src="docs/images/ios-dashboard-light-400.png" alt="OpenTask iOS app — light mode" width="160" align="middle">
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/images/ios-dashboard-dark-400.png" alt="OpenTask iOS app — dark mode" width="160" align="middle">
</p>

> [!NOTE]
> **Early release** — Please bear with the rough edges. 👷 Expect occasional bugs and other issues as things get ironed out. Please [open an issue](https://github.com/trentmcnitt/opentask/issues) if you run into any problems.

OpenTask is a self-hosted, AI-powered task and habit manager I built for personal use. I've been using it daily, and it's reached a point where I'm excited to open it up.

It runs as a single Docker container with SQLite — no Postgres, no Redis, no external services to manage. Your data lives in one file on your server.

## ✨ Features

### 🗓️ Tasks, reminders, and quotas

- **Targets and deadlines** — A task's target is when it starts nagging: a soft date you can defer as often as you like. Its deadline, when it has one, is the real cutoff — no defer moves it, and every defer stops at it. A deadline with no target of your own gets an automatic one a few days before, or you can set a target relative to it ("the evening before") that moves when the deadline does. [More →](https://opentask.mcnitt.io/docs/concepts/tasks#deadline)
- **Defer everything** — Bulk defer all overdue tasks in one tap: High-priority tasks move only when nothing lower is left, and Urgent ones always need a deliberate decision. Individual defer with presets, fine-grained adjustments, or custom times.
- **Nothing quietly falls off** — Undated tasks come back round on the Reminders screen at the pace of their horizon (days, weeks, months, or eventually). A task with a target you picked stays quiet until its heads-up in **Upcoming**: _Tomorrow_ the day before, _Later_ a lead time ahead that you can set per task. [More →](https://opentask.mcnitt.io/docs/concepts/reminders#task-segments)
- **Repeats** — Repeat on the target or on the deadline, end after a number of times or on a date, and skip ahead past a trip. [More →](https://opentask.mcnitt.io/docs/concepts/recurrence)
- **Reminders and quotas** — Recurring reminders grouped into periods of the day (Early morning through Evening by default — yours to edit), checked off as a list. Quotas count toward a target per day, week, month, or year, or every N days, weeks, or months ("read 5 times a week", "back up the laptop every 2 weeks"), grouped and filtered by label. Unmet quotas also show up among the day's reminders. [More →](https://opentask.mcnitt.io/docs/concepts/quotas)
- **Optional task queue** — A server-wide switch (`OPENTASK_TASK_QUEUE=1`) for breaking the defer treadmill. The day turns at your **Day starts at** time (3:00 AM by default) instead of midnight; whatever you kept deferring is taken off the overdue list into a queue at the start of the next day; you can put a task **on deck** for a day without it nagging; and a deadline with no target of your own waits on a **deadlines page** from its lead day instead of getting an automatic target. [More →](https://opentask.mcnitt.io/docs/concepts/task-queue)

### 📱 The apps (web, iPhone, Apple Watch, Mac)

- **Mobile-first PWA** — Installable on iOS and Android. Designed for phones first, looks great on desktop too.
- **Native Apple apps** — An iPhone app with home-screen widgets and rich notifications (defer grids and period checklists right from the lock screen), a full Apple Watch app with its own pages and Smart Stack widgets, and a Mac app with widgets and a menu bar item (overdue badge, quick add, one-click defer). (Source included — not on the App Store.) [More →](https://opentask.mcnitt.io/docs/ios/widgets-watch-mac)
- **Full undo/redo** — Every action is logged and reversible.
- **Trash & archive** — Deleted tasks go to trash, completed tasks go to archive. Nothing is permanently lost until you say so.

### 🏠 Self-hosting

- **Single container** — SQLite with WAL mode. No external database, no message queue, no cache layer. Back up your data by copying one file.
- **Reverse proxy auth** — Works with Authelia, Authentik, and other auth proxies out of the box.
- **Data export** — JSON and CSV export of all your tasks, projects, and completions. Nothing is locked in.

### 🔧 Automation

- **Full REST API** — Every UI operation available over HTTP. Bearer token auth, [interactive API docs](https://opentask.mcnitt.io/docs/api/), and curl-friendly. Script it, automate it, pipe it into Apple Shortcuts.
- **Webhooks** — HTTP callbacks on task events with HMAC-SHA256 signing. Integrate with n8n, Home Assistant, or anything that accepts webhooks.

## 🧠 AI-native task management (optional)

Type or dictate a task the way you'd say it, and AI fills in the details. It sets only what your words say — it never guesses a deadline from urgency or a project from the topic — and a quiet notification tells you what it set.

<p align="center">
  <img src="docs/images/filled-task-input-light.png" alt="Quick add field with a natural-language task typed in" width="500">
</p>

- **Natural language input** — "Call the dentist next Tuesday at 2pm to reschedule, it's important" becomes a structured task: AI extracts the title, target, recurrence, priority, project, and notes, plus a deadline when you state one, or a target relative to it ("remind me the evening before").
- **Reminders and quotas too** — Add a reminder as a sentence ("every weekday evening, check the back door") and AI sets its schedule and puts it in your evening period. Add a quota the same way ("lift 3x a week") and AI sets its count and period.
- **Process** — One dialog works through your Inbox and backlog: AI suggests a project for each Inbox task and spots likely duplicates, alongside rule-based steps for horizons and old targets. You decide; nothing changes on its own.
- **Tested, not hoped** — A 250+ scenario eval suite checks every feature: schema and field checks first, then an LLM judge scoring each answer against a rubric.
- **Entirely optional** — Disabled by default. Turn it off and every trace of AI disappears from the UI. Works with Claude, GPT-4.1-mini, Grok, DeepSeek, Ollama, and others, with a separate model for each feature.

More in the [AI docs →](https://opentask.mcnitt.io/docs/setup/ai)

## 🚀 Quick Start (Docker)

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

> [!TIP]
> Run `docker compose logs -f` to see startup output and troubleshoot any issues.

### Updating

```bash
docker compose pull
docker compose up -d
```

Your data is stored in `./data/` and persists across updates. Store this directory on a local filesystem — network mounts (NFS, CIFS) are not compatible with SQLite's file locking.

### Backup

SQLite makes backups simple — use the built-in `.backup` command for a safe, consistent copy:

```bash
# While running (recommended)
docker compose exec opentask sqlite3 /app/data/tasks.db '.backup /app/data/backup.db'
cp data/backup.db /path/to/your/backups/tasks-$(date +%F).db

# Or stop first, then copy directly
docker compose stop
cp data/tasks.db /path/to/your/backups/
docker compose start
```

> [!TIP]
> SQLite uses WAL (write-ahead logging), so `tasks.db-wal` and `tasks.db-shm` files may exist alongside the main database. A plain `cp tasks.db` while the app is running could produce an inconsistent backup. The `sqlite3 .backup` command handles this correctly.

### Additional Users

Create more users from the command line:

```bash
# Docker
docker compose exec opentask tsx scripts/create-user.ts <username> <password>

# Bare metal
npx tsx scripts/create-user.ts <username> <password> <email> <timezone>
```

### API Tokens

Create a Bearer token for API access and automation:

```bash
# Docker
docker compose exec opentask tsx scripts/create-token.ts <username> [token-name]

# Bare metal
npm run db:create-token -- <username> [token-name]
```

## 🛠️ Manual Installation

Requires Node.js 20+ and npm.

```bash
git clone https://github.com/trentmcnitt/opentask.git
cd opentask
npm install

# Configure
cp .env.example .env.local
# Edit .env.local — at minimum, set AUTH_SECRET (openssl rand -base64 32)

# Create your user
npx tsx scripts/create-user.ts admin changeme admin@localhost America/New_York

# Build and start
npm run build
npm run start
```

For development: `npm run dev` starts a hot-reloading server on port 3000.

## ⚙️ Configuration

See `.env.example` for all options. The essentials:

| Variable              | Required | Description                                         |
| --------------------- | -------- | --------------------------------------------------- |
| `AUTH_SECRET`         | Yes      | Secret key for sessions (`openssl rand -base64 32`) |
| `AUTH_URL`            | No       | Public URL when behind a reverse proxy              |
| `OPENTASK_DB_PATH`    | No       | SQLite database path (default: `./data/tasks.db`)   |
| `OPENTASK_AI_ENABLED` | No       | Enable AI features (default: `false`)               |

Login is **username-based**, not email-based.

### Reverse Proxy

OpenTask runs on port 3000 by default. Set `AUTH_URL` to your public URL when using a reverse proxy.

<details>
<summary>Caddy</summary>

```
tasks.example.com {
    reverse_proxy localhost:3000
}
```

</details>

<details>
<summary>Nginx</summary>

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

</details>

> [!NOTE]
> OpenTask uses Server-Sent Events for real-time updates. Caddy handles this automatically. Nginx needs `proxy_buffering off`.

### Reverse Proxy Header Auth

If you run an auth proxy like [Authelia](https://www.authelia.com/), [Authentik](https://goauthentik.io/), or Caddy's `forward_auth`, OpenTask can trust the authenticated username from a request header — no separate login required.

```yaml
# docker-compose.yml
environment:
  OPENTASK_PROXY_AUTH_HEADER: Remote-User
```

The header value must match an existing OpenTask username (case-insensitive). Users are not auto-created.

> [!WARNING]
> Your reverse proxy **must** strip this header from external requests. If external clients can set this header directly, they can authenticate as any user.

### Push Notifications

- **Web Push** — Generate VAPID keys with `npx web-push generate-vapid-keys` and set them in your environment. Works on all platforms including iOS Safari.
- **iOS Native (APNs)** — Requires the iOS companion app and an Apple Developer Program membership. See `.env.example` for configuration.

### AI Features

AI is entirely optional — disabled by default. See [AI-native task management](#ai-native-task-management-optional) above for what it provides. Add `OPENTASK_AI_ENABLED=true` and a provider key to your `.env` file — see `.env.example` for setup with Claude, GPT-4.1-mini, Grok, DeepSeek, and Ollama.

What's Next, Insights, and Quick Take are [shelved](https://opentask.mcnitt.io/docs/setup/ai#shelved-features) until they're redesigned; a server can bring them back with `OPENTASK_AI_UNSHELVE=1`.

## 🔗 API

Three auth methods, checked in order: **Bearer token** → **Proxy header** → **Session cookie**

Key endpoints:

| Endpoint                         | Method   | Description                            |
| -------------------------------- | -------- | -------------------------------------- |
| `/api/tasks`                     | GET      | List tasks with filters                |
| `/api/tasks`                     | POST     | Create a task                          |
| `/api/tasks/:id`                 | PATCH    | Update task fields                     |
| `/api/tasks/:id`                 | DELETE   | Soft delete to trash                   |
| `/api/tasks/:id/done`            | POST     | Mark done (advances recurring)         |
| `/api/tasks/:id/snooze`          | POST     | Defer to a later time                  |
| `/api/tasks/bulk/snooze-overdue` | POST     | One-tap defer all overdue tasks        |
| `/api/tasks/bulk/done`           | POST     | Bulk mark done                         |
| `/api/tasks/bulk/snooze`         | POST     | Bulk defer by task IDs                 |
| `/api/reminders`                 | GET      | Reminders by period, and task segments |
| `/api/undo`                      | POST     | Undo last action                       |
| `/api/redo`                      | POST     | Redo last undone action                |
| `/api/projects`                  | GET/POST | List/create projects                   |
| `/api/export`                    | GET      | Export data (JSON or CSV)              |
| `/api/webhooks`                  | GET/POST | List/create webhooks                   |
| `/api/openapi`                   | GET      | OpenAPI 3.1 spec (no auth)             |

Full API reference with curl examples, webhook setup, and Apple Shortcuts integration: **[Documentation →](https://opentask.mcnitt.io/docs/automation/getting-started)**

## 🧱 Tech Stack

| Layer    | Technology                                           |
| -------- | ---------------------------------------------------- |
| Runtime  | Next.js 16 (App Router) + React 19 + TypeScript      |
| Database | SQLite with WAL mode (better-sqlite3)                |
| Auth     | NextAuth/Auth.js (credentials, JWT sessions)         |
| Styling  | Tailwind CSS 4 + Shadcn UI                           |
| Testing  | Vitest (behavioral + integration) + Playwright (E2E) |

## 📁 Project Structure

```
src/
├── app/              # Next.js pages and API routes
├── components/       # React components
├── core/             # Business logic (auth, db, tasks, recurrence, undo, ai)
├── hooks/            # Custom React hooks
├── lib/              # Utilities
└── types/            # TypeScript types
ios/                  # Native iPhone and Apple Watch apps (SwiftUI; the iPhone app wraps the PWA)
macos/                # Native Mac app with widgets and a menu bar item
tests/                # Behavioral, integration, E2E, and AI quality tests
docs/                 # Product spec, design rationale, API guide, roadmap
```

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

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

## 👤 Author

Built by [Trent McNitt](https://mcnitt.io) — AI implementation consultant specializing in chatbots, workflow automation, and custom AI applications.

[Available for contract work →](https://mcnitt.io)

## 📄 License

[AGPL-3.0](LICENSE)
