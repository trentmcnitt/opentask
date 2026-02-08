# AI Integration — Design Document

_Version 0.3 — 2026-02-08_

This is the authoritative reference for AI integration in OpenTask. It covers principles, architecture, failure handling, and the feature catalog.

---

## Table of Contents

1. [Principles](#principles)
2. [Architecture](#architecture)
3. [Module Structure](#module-structure)
4. [Robustness](#robustness)
5. [Failure Modes](#failure-modes)
6. [Feature Catalog](#feature-catalog)
7. [Configuration](#configuration)
8. [Activity Logging](#activity-logging)
9. [Data Retention](#data-retention)

---

## Principles

### Certainty first

The task is always saved before AI is consulted. If the user types "call dentist next Tuesday high priority" and presses Enter, the task exists in the database within milliseconds. AI enrichment happens asynchronously — if it fails, the raw text is preserved exactly as typed. The user never loses data because of an AI failure.

### Transcriptionist, not editor

The enrichment prompt treats user input as dictation to be cleaned, not prose to be rewritten. Clean up: artifacts, rambling, repetition, false starts. Preserve exactly: word choices, framing, specific claims. Never add concepts the user didn't use.

This is especially important because users often dictate tasks while driving or multitasking — input may be garbled, stream-of-consciousness, or oddly phrased.

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
| What's Next?              | Haiku       | Fast, on-demand recommendations    |
| Daily briefing            | Haiku       | Summarization, low stakes          |
| AI triage                 | Haiku       | Interactive, user is waiting       |
| Shopping labels           | Haiku       | Simple classification              |
| Chat sidebar              | Sonnet      | Conversational, needs reasoning    |
| Complex analysis          | Sonnet/Opus | Needs deep understanding           |

The SDK supports per-query model selection, so each feature chooses its own model.

### AI-locked protection

Tasks with the `ai-locked` label are never processed by AI. This gives users an escape hatch for tasks they want to keep exactly as written. The queue checks for this label and skips the task (setting `ai_status` to null).

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

The cron runs every 10 seconds. Tasks are processed with round-robin fairness across users (up to 10 per cycle) to prevent any single user from starving others.

### Shared project support

Enrichment queries both owned and shared projects when building the project list for AI. This allows the model to route tasks to shared projects (e.g., a shared "Shopping List"). The project list format indicates which projects are shared:

```
- Inbox (id: 1)
- Shopping List (id: 5, shared)
```

### Concurrent request management

A semaphore in `queue.ts` limits concurrent SDK subprocesses (default: 2). All AI queries (enrichment, What's Next, briefing, triage, shopping labels) acquire a slot before spawning a subprocess. Requests beyond the limit are queued FIFO with a 30-second timeout.

---

## Module Structure

All AI code lives in `src/core/ai/`:

```
src/core/ai/
├── types.ts         — TypeScript types and Zod schemas
├── activity.ts      — Activity log read/write
├── prompts.ts       — System prompts for each feature
├── sdk.ts           — SDK wrapper (init, query, error handling, timeout)
├── queue.ts         — Concurrent request semaphore (FIFO, configurable limit)
├── parse-helpers.ts — Shared JSON extraction from text responses
├── enrichment.ts    — Task enrichment pipeline (circuit breaker, round-robin, shopping labels)
├── whats-next.ts    — "What's Next?" AI recommendations (cached 5 min)
├── briefing.ts      — Daily briefing generation (cached 4 hours in activity log)
├── triage.ts        — AI triage / task ordering (cached 5 min)
├── shopping.ts      — Shopping list label classification
├── purge.ts         — Activity log data retention
└── index.ts         — Barrel exports
```

### `types.ts`

- `EnrichmentResultSchema` — Zod schema for task enrichment output
- `WhatsNextResultSchema` — recommended tasks + summary
- `BriefingResultSchema` — greeting + sections + items
- `TriageResultSchema` — ordered task IDs + reasoning
- `ShoppingLabelResultSchema` — store section + reasoning
- `TaskSummary` — compact task representation for AI prompts
- `AIActivityEntry` — shape of activity log rows

### `prompts.ts`

- `ENRICHMENT_SYSTEM_PROMPT` — task parsing with transcriptionist philosophy
- `WHATS_NEXT_SYSTEM_PROMPT` — recommend 3-7 tasks to focus on
- `BRIEFING_SYSTEM_PROMPT` — conversational daily briefing with sections
- `TRIAGE_SYSTEM_PROMPT` — order tasks by importance
- `SHOPPING_LABEL_SYSTEM_PROMPT` — classify items by store section

### `sdk.ts`

- `initAI()` — called from `instrumentation.ts`, validates SDK
- `aiQuery(options)` — wraps SDK `query()` with error handling, timeout, semaphore, and activity logging
- `isAIEnabled()` — checks `OPENTASK_AI_ENABLED` env var

### `queue.ts`

- `acquireSlot()` / `releaseSlot()` — FIFO semaphore
- `withSlot(fn)` — convenience wrapper with automatic release
- `getQueueStats()` — returns active/waiting/max for monitoring

### `enrichment.ts`

- `processEnrichmentQueue()` — cron entry point with round-robin fairness, circuit breaker, shopping label integration
- `enrichTask(task, user)` — runs SDK query with structured output
- `applyEnrichment(task, result, user)` — applies changes via `withTransaction()` + `logAction()`
- `resetStuckTasks()` — resets `'processing'` tasks to `'pending'` on startup

### `whats-next.ts`

- `generateWhatsNext(userId, timezone, tasks)` — returns 3-7 recommended tasks with reasons
- 5-minute in-memory cache per user
- Task selection scoring: overdue > due soon > high priority > stale

### `briefing.ts`

- `getBriefing(userId, timezone, tasks, refresh?)` — returns cached or fresh briefing
- Cache persistence via `ai_activity_log` (4-hour TTL)
- Includes task stats: overdue count, due today, recurring, high priority, stale

### `triage.ts`

- `triageTasks(userId, timezone, tasks)` — returns ordered task IDs by importance
- 5-minute in-memory cache per user
- Used by "AI Pick" filter chip on dashboard

### `shopping.ts`

- `isShoppingProject(name)` — name-based heuristic (contains "shop"/"grocer")
- `getShoppingLabels(userId, title, projectName)` — classifies item by store section
- Integrated into enrichment: runs after normal enrichment for shopping projects

---

## Robustness

### Circuit breaker

The enrichment queue tracks rapid consecutive failures. If 5 tasks fail within 60 seconds, the queue pauses for 5 minutes and logs a warning. This prevents infinite failure loops when the underlying service is down.

### Request timeout

Every SDK query has a configurable timeout (default 60 seconds). If the subprocess doesn't respond within the timeout, the `AbortController` kills it and the query returns an error.

### Stuck task detection

Each queue cycle checks for tasks stuck in `'processing'` for longer than 2 minutes. These are reset to `'pending'`. On server startup, `resetStuckTasks()` resets all `'processing'` tasks.

### Concurrent request limiting

The semaphore in `queue.ts` (default max 2) prevents resource exhaustion from multiple simultaneous AI features. Queue waiters time out after 30 seconds.

### Round-robin fairness

The enrichment queue uses round-robin scheduling across users. Tasks from different users are interleaved, so no single user's backlog can starve others.

---

## Failure Modes

| Failure                        | What happens                                         | User sees                         |
| ------------------------------ | ---------------------------------------------------- | --------------------------------- |
| SDK not installed              | `isAIEnabled()` returns false                        | Nothing — app works normally      |
| Subprocess fails to start      | `ai_status` stays `'pending'`, retried next cycle    | Spinner continues                 |
| Subprocess hangs               | Timeout kills after 60s, `ai_status = 'failed'`      | Warning icon, raw text preserved  |
| Model returns invalid output   | `ai_status = 'failed'`, error logged                 | Warning icon, raw text preserved  |
| Model extracts wrong fields    | Changes applied and logged in undo                   | User can Cmd+Z to revert          |
| Server restarts mid-enrichment | `'processing'` tasks reset to `'pending'` on startup | Re-processed automatically        |
| Task has `ai-locked` label     | Enrichment skipped, `ai_status` set to null          | No AI processing                  |
| Rapid consecutive failures     | Circuit breaker pauses queue for 5 minutes           | Pending tasks wait                |
| Semaphore full                 | Request queued FIFO, times out after 30 seconds      | Loading indicator, eventual error |
| What's Next/triage cache hit   | Cached result returned immediately                   | Instant response                  |
| Briefing cache hit             | Cached result from activity log                      | Instant page load                 |

**No auto-retry on failure.** Failed tasks stay failed to prevent cost runaway.

---

## Feature Catalog

### Implemented

| Feature         | Description                                 | Model | Trigger               | Cache   |
| --------------- | ------------------------------------------- | ----- | --------------------- | ------- |
| Task enrichment | Parse natural language into structured task | Haiku | Task creation (async) | —       |
| What's Next?    | AI-recommended tasks to focus on            | Haiku | Dashboard panel (GET) | 5 min   |
| Daily briefing  | Structured daily overview at /briefing      | Haiku | On-demand page load   | 4 hours |
| AI triage       | Reorder tasks by AI-assessed importance     | Haiku | "AI Pick" filter chip | 5 min   |
| Shopping labels | Auto-label items by store section           | Haiku | During enrichment     | —       |

### Planned

| Feature      | Description                        | Model  | Status   |
| ------------ | ---------------------------------- | ------ | -------- |
| Chat sidebar | Conversational AI about your tasks | Sonnet | Deferred |

---

## Configuration

| Env var                               | Default | Description                                         |
| ------------------------------------- | ------- | --------------------------------------------------- |
| `OPENTASK_AI_ENABLED`                 | `false` | Master switch — all AI features disabled when false |
| `OPENTASK_AI_ENRICHMENT_MODEL`        | `haiku` | Model for task enrichment                           |
| `OPENTASK_AI_ENRICHMENT_INTERVAL`     | `10`    | Seconds between queue checks                        |
| `OPENTASK_AI_QUERY_TIMEOUT_MS`        | `60000` | Timeout for SDK queries in milliseconds             |
| `OPENTASK_AI_CLI_PATH`                | (auto)  | Path to Claude Code CLI executable                  |
| `OPENTASK_AI_MAX_CONCURRENT`          | `2`     | Maximum concurrent SDK subprocesses                 |
| `OPENTASK_AI_QUEUE_TIMEOUT_MS`        | `30000` | Maximum wait time for semaphore slot                |
| `OPENTASK_AI_WHATS_NEXT_MODEL`        | `haiku` | Model for What's Next recommendations               |
| `OPENTASK_AI_BRIEFING_MODEL`          | `haiku` | Model for daily briefing                            |
| `OPENTASK_AI_TRIAGE_MODEL`            | `haiku` | Model for AI triage                                 |
| `OPENTASK_AI_SHOPPING_MODEL`          | `haiku` | Model for shopping label classification             |
| `OPENTASK_RETENTION_AI_ACTIVITY_DAYS` | `90`    | Days to retain AI activity log entries              |

No API key needed — the SDK uses Claude Code's authentication on the server.

---

## Activity Logging

Every AI operation is logged in the `ai_activity_log` table:

| Column        | Type    | Description                                                                              |
| ------------- | ------- | ---------------------------------------------------------------------------------------- |
| `id`          | INTEGER | Primary key                                                                              |
| `user_id`     | INTEGER | Who owns the task                                                                        |
| `task_id`     | INTEGER | Which task (nullable for non-task operations)                                            |
| `action`      | TEXT    | Operation type: `'enrich'`, `'whats_next'`, `'briefing'`, `'triage'`, `'shopping_label'` |
| `status`      | TEXT    | `'success'`, `'error'`, `'skipped'`                                                      |
| `input`       | TEXT    | Raw input (e.g., original task text)                                                     |
| `output`      | TEXT    | JSON result from AI                                                                      |
| `model`       | TEXT    | Which model was used                                                                     |
| `duration_ms` | INTEGER | How long the query took                                                                  |
| `error`       | TEXT    | Error message if failed                                                                  |
| `created_at`  | TEXT    | ISO 8601 timestamp                                                                       |

The briefing feature also uses this table for cache persistence (action='briefing', status='success').

---

## Data Retention

| Data            | Retention | Purge schedule        | Env var override                      |
| --------------- | --------- | --------------------- | ------------------------------------- |
| Undo log        | 30 days   | Daily at 3:00 AM      | `OPENTASK_RETENTION_UNDO_DAYS`        |
| Trash           | 30 days   | Daily at 3:30 AM      | `OPENTASK_RETENTION_TRASH_DAYS`       |
| Completions     | 30 days   | Daily at 4:00 AM      | `OPENTASK_RETENTION_COMPLETIONS_DAYS` |
| Daily stats     | 4 weeks   | Weekly Sunday 4:30 AM | —                                     |
| AI activity log | 90 days   | Daily at 5:00 AM      | `OPENTASK_RETENTION_AI_ACTIVITY_DAYS` |

AI activity has a longer retention than other data because it's useful for prompt tuning and cost analysis.
