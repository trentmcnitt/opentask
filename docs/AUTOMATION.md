# External Automation Guide

Reference for automating OpenTask via the REST API — from iOS/Mac Shortcuts, Claude Code, scripts, or any HTTP client.

## Authentication

All API requests require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

### Creating a token

```bash
npm run db:create-token -- <username> [token-name]

# Examples:
npm run db:create-token -- Trent               # name defaults to "API"
npm run db:create-token -- Trent "iOS Shortcut" # custom name
```

The script prints the token to stdout. Store it securely — it cannot be retrieved later.

## Quick Add (Recommended for Shortcuts/Siri)

Send raw dictated text and let AI enrichment handle the rest:

```bash
curl -X POST https://tasks.tk11.mcnitt.io/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "call the dentist tomorrow morning high priority"}'
```

The AI extracts: clean title, due date, priority, labels, recurrence, project, auto-snooze, and context notes. The raw input is preserved in `original_title` for retry if enrichment fails.

### What enrichment extracts

| Field               | Example input                              | Extracted                   |
| ------------------- | ------------------------------------------ | --------------------------- |
| title               | "um call dentist tomorrow"                 | "Call dentist"              |
| due_at              | "tomorrow morning", "next Tuesday at 2pm"  | ISO 8601 UTC datetime       |
| priority            | "high priority", "urgent", "no rush"       | 0-4 integer                 |
| labels              | "call the dentist"                         | ["medical"]                 |
| rrule               | "every Monday", "daily"                    | RFC 5545 RRULE string       |
| project_name        | "add to family"                            | Matched to existing project |
| auto_snooze_minutes | "auto-snooze 30 minutes"                   | Integer (0-1440)            |
| recurrence_mode     | "repeat from completion"                   | "from_completion"           |
| notes               | "claim number 847293, call 1-800-555-0123" | Supplementary context       |

### Wall-of-text example

Input:

> "I need to call my insurance company about the claim they denied for the ER visit, claim number 847293, call 1-800-555-0123, do this tomorrow morning, high priority, the appeal deadline is coming up"

Result:

- **title**: "Call insurance company about denied ER claim"
- **due_at**: tomorrow 9am (UTC-converted)
- **priority**: 3 (high)
- **notes**: "Claim #847293 for ER visit. Call 1-800-555-0123. Appeal deadline approaching."

## Skipping AI Enrichment

Send structured fields to bypass enrichment entirely:

```bash
curl -X POST https://tasks.tk11.mcnitt.io/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Team standup",
    "due_at": "2026-02-15T15:00:00Z",
    "priority": 2,
    "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "labels": ["work"],
    "project_id": 1
  }'
```

AI enrichment only triggers for title-only tasks (no due_at, priority=0, no labels, no rrule).

## Reprocessing Failed Enrichment

If enrichment fails (task gets `ai-failed` label), retry it:

```bash
curl -X POST https://tasks.tk11.mcnitt.io/api/tasks/42/reprocess \
  -H "Authorization: Bearer $TOKEN"
```

This uses `original_title` (the raw input) — not the current title — so the AI gets the full original text even if the title was manually edited.

## Key Endpoints

### Tasks

| Method | Endpoint                   | Description                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/tasks`               | Create task                                                                           |
| GET    | `/api/tasks`               | List tasks (query params: `done`, `project_id`, `label`, `search`, `limit`, `offset`) |
| GET    | `/api/tasks/:id`           | Get single task                                                                       |
| PATCH  | `/api/tasks/:id`           | Update task fields                                                                    |
| DELETE | `/api/tasks/:id`           | Soft-delete (trash)                                                                   |
| POST   | `/api/tasks/:id/done`      | Mark done                                                                             |
| POST   | `/api/tasks/:id/undone`    | Mark undone                                                                           |
| POST   | `/api/tasks/:id/snooze`    | Snooze (`{"until": "ISO8601"}`)                                                       |
| POST   | `/api/tasks/:id/restore`   | Restore from trash                                                                    |
| POST   | `/api/tasks/:id/reprocess` | Retry AI enrichment                                                                   |

### Undo

| Method | Endpoint    | Description             |
| ------ | ----------- | ----------------------- |
| POST   | `/api/undo` | Undo last action        |
| POST   | `/api/redo` | Redo last undone action |

## Response Format

**Success:**

```json
{ "data": { "id": 42, "title": "Call dentist", "original_title": "call the dentist tomorrow morning high priority", "priority": 3, ... } }
```

Task responses include `original_title` — the raw input text before AI enrichment cleaned it up. This is always preserved and used for reprocessing.

**Error:**

```json
{ "error": "Not found", "code": "NOT_FOUND" }
```

### Status codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 200  | Success                              |
| 201  | Created                              |
| 400  | Validation error (bad input)         |
| 401  | Unauthorized (missing/invalid token) |
| 403  | Forbidden (no access to resource)    |
| 404  | Not found                            |
| 500  | Internal error                       |

## iOS Shortcuts Tips

1. **HTTP method**: Use "Get Contents of URL" action with method POST
2. **Headers**: Add `Authorization: Bearer <token>` and `Content-Type: application/json`
3. **Body**: Use "Request Body" → JSON with a single `title` key containing the dictated text
4. **Siri trigger**: Name the shortcut "Add Task" for "Hey Siri, Add Task"
5. **Response**: Parse the JSON response `data.id` to confirm creation
