# OpenTask Roadmap

Curated feature list for OpenTask. Items move to implementation when they're ready.

## Implemented

- **Data Export** — JSON and CSV export of tasks, projects, and completions via `GET /api/export`
- **Webhooks** — HTTP callbacks on task events with HMAC-SHA256 signing, delivery logging, and retry
- **Reverse Proxy Header Auth** — Authenticate via trusted proxy headers (Authelia, Authentik, Caddy forward_auth)
- **OpenAPI Spec** — Machine-readable API documentation at `GET /api/openapi`

## Planned

- **Webhook Management UI** — Settings page to create, view, toggle, and debug webhooks without curl
- **OIDC / SSO** — OpenID Connect support for single sign-on (Authelia, Authentik, Keycloak)
- **Data Import** — Import from Todoist, OpenTask JSON export, and generic CSV
- **Subtasks / Checklists** — Nested tasks or checklist items within a task

## Under Consideration

- **CalDAV Sync** — Two-way sync with CalDAV clients (Apple Reminders, Thunderbird, DAVx5)
- **Kanban View** — Board view with columns mapped to projects or priority levels
- **Project Icons** — Emoji or icon per project, displayed in project list and task grouping headers
- **Per-Project Notification Grouping** — Group notifications by project for separate notification stacks

## Not Planned

These features are out of scope for OpenTask. OpenTask is a personal task manager, not a project management tool.

- **Gantt Charts** — Timeline visualization is project management territory
- **Time Tracking** — Use a dedicated time tracker; task completion stats cover the basics
- **Sprints / Iterations** — Agile workflow tooling doesn't fit a personal task manager
- **Multi-User Assignment** — Tasks belong to one person; shared projects provide collaboration without assignment complexity
