# AI Integration — Design Document

_Version 0.1 — 2026-02-08_

This is the authoritative reference for AI integration in OpenTask. It covers principles, architecture, failure handling, and the feature catalog.

---

## Table of Contents

1. [Principles](#principles)
2. [Architecture](#architecture)
3. [Module Structure](#module-structure)
4. [Failure Modes](#failure-modes)
5. [Feature Catalog](#feature-catalog)
6. [Configuration](#configuration)
7. [Activity Logging](#activity-logging)

---

## Principles

### Certainty first

The task is always saved before AI is consulted. If the user types "call dentist next Tuesday high priority" and presses Enter, the task exists in the database within milliseconds. AI enrichment happens asynchronously — if it fails, the raw text is preserved exactly as typed. The user never loses data because of an AI failure.

### Graceful failure

There are two distinct failure modes:

1. **Request failed in chain** — the SDK subprocess didn't start, the model timed out, the response was malformed. The task is untouched, `ai_status` is set to `'failed'`, and the error is logged. The user sees a warning icon on the task but their raw text is intact.

2. **AI did something wrong** — the model returned valid JSON but extracted the wrong priority, misunderstood the due date, or assigned the wrong project. The changes were applied and logged in the undo system. The user can Cmd+Z (or tap undo) to revert all AI changes atomically.

Both failure modes must be handled. The system must never silently corrupt data.

### Undo integration

Every AI mutation is logged through the existing undo system using the standard `logAction()` + `createTaskSnapshot()` pattern. AI changes use the `'edit'` action type with AI-prefixed descriptions (e.g., "AI: Enriched task — set title, due date, priority"). This means:

- AI changes appear in the undo history alongside manual edits
- Cmd+Z reverts the entire AI enrichment atomically
- The history page shows what AI changed and when

### Right model for the job

Different features have different latency and intelligence requirements:

| Use case                  | Model       | Why                                |
| ------------------------- | ----------- | ---------------------------------- |
| Task enrichment (parsing) | Haiku       | Fast, cheap, structured extraction |
| Chat sidebar              | Sonnet      | Conversational, needs reasoning    |
| Morning briefing          | Haiku       | Summarization, low stakes          |
| Complex triage/analysis   | Sonnet/Opus | Needs deep understanding           |

The SDK supports per-query model selection, so each feature chooses its own model.

### AI-locked protection

Tasks with the `ai-locked` label are never processed by AI. This gives users an escape hatch for tasks they want to keep exactly as written.

---

## Architecture

### SDK inside Next.js

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) runs inside the OpenTask Next.js process. There is no separate AI service, no message queue, no worker process. The SDK spawns Claude Code subprocesses on demand.

**Why this approach:**

- Direct database access — AI can read projects, labels, and user preferences without an API layer
- Single deploy — one `deploy.sh` command updates everything
- Atomic transactions — AI mutations use the same `withTransaction()` as manual edits
- Single log stream — `journalctl -u opentask` shows everything
- Sufficient for 1-2 users on a dedicated server

**How it works:**

1. The SDK's `query()` function spawns a Claude Code subprocess
2. The subprocess runs the prompt with the specified model and tools
3. Structured output (`outputFormat` with JSON Schema) guarantees valid responses
4. The subprocess exits after the query completes
5. Results are applied to the database through existing core mutation functions

**Prerequisites:** Claude Code must be installed and authenticated on the server. The SDK uses Claude Code's existing authentication (Max subscription) — no API key needed.

### Async enrichment pattern

Task enrichment is asynchronous by design:

```
User types → Task saved immediately → ai_status = 'pending'
                                           ↓
                                    Cron picks up task
                                           ↓
                                    ai_status = 'processing'
                                           ↓
                                    SDK query (Haiku)
                                           ↓
                                  ┌─── Success ───┐── Failure ──┐
                                  ↓                              ↓
                          Apply changes              ai_status = 'failed'
                          Log for undo               Log error
                          ai_status = 'complete'     User sees warning
```

The cron runs every 10 seconds. Tasks are processed sequentially (one at a time) to avoid overwhelming the server.

---

## Module Structure

All AI code lives in `src/core/ai/`:

```
src/core/ai/
├── types.ts         — TypeScript types and Zod schemas
├── activity.ts      — Activity log read/write
├── prompts.ts       — System prompts for each feature
├── sdk.ts           — SDK wrapper (init, query, error handling)
└── enrichment.ts    — Task enrichment pipeline
```

### `types.ts`

- `AIStatus` — `'pending' | 'processing' | 'complete' | 'failed'`
- `EnrichmentResult` — Zod schema for structured output (title, due_at, priority, labels, project_name, rrule, reasoning)
- `AIActivityEntry` — shape of activity log rows

### `activity.ts`

- `logAIActivity(entry)` — writes to `ai_activity_log` table
- `getAIActivity(userId, options)` — queries activity log (for future UI)

### `prompts.ts`

- `ENRICHMENT_SYSTEM_PROMPT` — instructions for task parsing: priority values (0-4), RRULE format with examples, timezone rules, label extraction guidance, "if uncertain, leave null"

### `sdk.ts`

- `initAI()` — called from `instrumentation.ts`, validates SDK is available
- `aiQuery(options)` — wraps SDK `query()` with error handling, duration measurement, and activity logging
- `isAIEnabled()` — checks `OPENTASK_AI_ENABLED` env var

### `enrichment.ts`

- `processEnrichmentQueue()` — cron entry point, picks up `ai_status = 'pending'` tasks
- `enrichTask(task, user)` — runs SDK query with structured output
- `applyEnrichment(task, result, user)` — applies changes via `withTransaction()` + `logAction()`

---

## Failure Modes

| Failure                        | What happens                                         | User sees                        |
| ------------------------------ | ---------------------------------------------------- | -------------------------------- |
| SDK not installed              | `isAIEnabled()` returns false                        | Nothing — app works normally     |
| Subprocess fails to start      | `ai_status` stays `'pending'`, retried next cycle    | Spinner continues                |
| Model returns invalid output   | `ai_status = 'failed'`, error logged                 | Warning icon, raw text preserved |
| Model extracts wrong fields    | Changes applied and logged in undo                   | User can Cmd+Z to revert         |
| Server restarts mid-enrichment | `'processing'` tasks reset to `'pending'` on startup | Re-processed automatically       |
| Task has `ai-locked` label     | Enrichment skipped                                   | No AI processing                 |

**No auto-retry on failure.** Failed tasks stay failed to prevent cost runaway. Manual re-enrichment can be added later.

**Stuck detection:** On startup, any task with `ai_status = 'processing'` is reset to `'pending'` (these were interrupted by a restart).

---

## Feature Catalog

### Implemented

- **Task enrichment (v1)** — see below

### v1: Task Enrichment

User types natural language in QuickAdd. Task saves immediately with raw text as the title. AI enriches asynchronously:

- Clean, concise title
- Due date extraction (relative dates like "next Tuesday", absolute dates)
- Priority detection ("high priority", "urgent", "low")
- Label extraction (contextual tags from the text)
- Recurrence detection ("every Monday", "daily at 9am") → RRULE
- Project routing (match project name from text)

**Model:** Haiku
**Trigger:** Task created with title only (no due_at, priority = 0, no labels, no rrule)
**MCP tool:** `list_projects` — lets the model resolve project names to IDs

### Planned

| Feature          | Description                              | Model        | Trigger               |
| ---------------- | ---------------------------------------- | ------------ | --------------------- |
| Chat sidebar     | Conversational AI about your tasks       | Sonnet       | User opens chat       |
| Morning briefing | Daily summary of what's ahead            | Haiku        | Daily cron            |
| AI triage        | Suggest priority/project for inbox tasks | Haiku/Sonnet | On-demand button      |
| Title rewrite    | Clean up a task title                    | Haiku        | Button on task detail |

All planned features share the same infrastructure: `sdk.ts` (wrapper), `activity.ts` (logging), and the `ai_activity_log` table.

---

## Configuration

| Env var                           | Default | Description                                         |
| --------------------------------- | ------- | --------------------------------------------------- |
| `OPENTASK_AI_ENABLED`             | `false` | Master switch — all AI features disabled when false |
| `OPENTASK_AI_ENRICHMENT_MODEL`    | `haiku` | Model for task enrichment                           |
| `OPENTASK_AI_ENRICHMENT_INTERVAL` | `10`    | Seconds between queue checks                        |

No API key needed — the SDK uses Claude Code's authentication on the server.

---

## Activity Logging

Every AI operation is logged in the `ai_activity_log` table:

| Column        | Type    | Description                                                    |
| ------------- | ------- | -------------------------------------------------------------- |
| `id`          | INTEGER | Primary key                                                    |
| `user_id`     | INTEGER | Who owns the task                                              |
| `task_id`     | INTEGER | Which task (nullable for non-task operations)                  |
| `action`      | TEXT    | Operation type: `'enrich'`, `'chat'`, `'briefing'`, `'triage'` |
| `status`      | TEXT    | `'success'`, `'error'`, `'skipped'`                            |
| `input`       | TEXT    | Raw input (e.g., original task text)                           |
| `output`      | TEXT    | JSON result from AI                                            |
| `model`       | TEXT    | Which model was used                                           |
| `duration_ms` | INTEGER | How long the query took                                        |
| `error`       | TEXT    | Error message if failed                                        |
| `created_at`  | TEXT    | ISO 8601 timestamp                                             |

This table is separate from the undo log. The undo log tracks what changed (for reverting). The activity log tracks AI operations (for debugging, cost visibility, and future UI).
