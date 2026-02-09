# AI Integration — Design Document

_Version 0.4 — 2026-02-09_

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
| Bubble                    | Haiku       | Infrequent, 3 AM cron + on-demand  |
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

**Prerequisites:** Claude Code must be installed and authenticated on the server. The SDK uses Claude Code's existing authentication (Max subscription) — no API key needed.

### Warm enrichment slot + per-query subprocess

The AI system uses two execution patterns:

**1. Warm enrichment slot** (`enrichment-slot.ts`): A dedicated Claude Code subprocess kept alive across requests via the MessageChannel pattern. Eliminates cold-start latency for enrichment, which is the most frequent AI operation (runs on every task creation).

How it works:

1. `initEnrichmentSlot()` creates a MessageChannel, starts a subprocess with `outputFormat` set to EnrichmentResultSchema
2. Pushes a warmup message and waits for validation
3. Subsequent requests push prompts through the same channel
4. After MAX_REUSES (default 8) results, the slot recycles (closes old subprocess, starts a new one)
5. Circuit breaker: 5 recycles in 5 seconds marks the slot as dead
6. FIFO wait queue handles concurrent access to the single slot

**2. Per-query subprocess** (`sdk.ts → aiQuery()`): For infrequent features (Bubble, briefing, triage). Cold-start latency doesn't matter when nobody's waiting. Each gets its own `outputFormat` per-query.

### On-demand enrichment

Task enrichment is on-demand: when a task is created, the API route fires and forgets `enrichSingleTask()` which sends the query through the warm enrichment slot. A 1-minute safety-net cron (`processEnrichmentQueue()`) picks up any `ai_status='pending'` tasks that the on-demand path missed.

```
User types → Task saved immediately → ai_status = 'pending'
                                           ↓
                                    Fire-and-forget enrichSingleTask()
                                           ↓
                                    ai_status = 'processing'
                                           ↓
                                    Warm enrichment slot query
                                           ↓
                                  ┌─── Success ───┐── Failure ──┐
                                  ↓                              ↓
                          Apply changes              ai_status = 'failed'
                          Log for undo               Log error
                          ai_status = 'complete'     User sees warning
```

Safety net: cron runs every 1 minute, picks up pending tasks with round-robin fairness across users.

### Shared project support

Enrichment queries both owned and shared projects when building the project list for AI. This allows the model to route tasks to shared projects (e.g., a shared "Shopping List"). The project list format indicates which projects are shared:

```
- Inbox (id: 1)
- Shopping List (id: 5, shared)
```

### Concurrent request management

A semaphore in `queue.ts` limits concurrent SDK subprocesses (default: 2). All per-query AI operations (Bubble, briefing, triage, shopping labels) acquire a slot before spawning a subprocess. The warm enrichment slot operates independently and does not use the semaphore.

---

## Module Structure

All AI code lives in `src/core/ai/`:

```
src/core/ai/
├── types.ts            — TypeScript types and Zod schemas
├── activity.ts         — Activity log read/write
├── prompts.ts          — System prompts for each feature
├── sdk.ts              — SDK wrapper (init, query, error handling, timeout)
├── queue.ts            — Concurrent request semaphore (FIFO, configurable limit)
├── parse-helpers.ts    — Shared JSON extraction from text responses
├── message-channel.ts  — Async iterable for subprocess communication
├── enrichment-slot.ts  — Warm slot for enrichment (MessageChannel + consumer + lifecycle)
├── enrichment.ts       — Task enrichment pipeline (on-demand + safety-net cron)
├── bubble.ts           — Bubble recommendations (surfaces overlooked tasks)
├── briefing.ts         — Daily briefing generation (cached 4 hours in activity log)
├── triage.ts           — AI triage / task ordering (cached 5 min)
├── shopping.ts         — Shopping list label classification
├── purge.ts            — Activity log data retention
├── task-summaries.ts   — Compact task data builder for AI prompts
└── index.ts            — Barrel exports
```

### `types.ts`

- `EnrichmentResultSchema` — Zod schema for task enrichment output
- `BubbleResultSchema` — surfaced tasks + reasons + summary
- `BriefingResultSchema` — greeting + sections + items
- `TriageResultSchema` — ordered task IDs + reasoning
- `ShoppingLabelResultSchema` — store section + reasoning
- `TaskSummary` — compact task representation for AI prompts
- `AIActivityEntry` — shape of activity log rows

### `prompts.ts`

- `ENRICHMENT_SYSTEM_PROMPT` — task parsing with transcriptionist philosophy
- `BUBBLE_SYSTEM_PROMPT` — surface overlooked tasks (social obligations, snoozed items, idle tasks)
- `BRIEFING_SYSTEM_PROMPT` — conversational daily briefing with sections
- `TRIAGE_SYSTEM_PROMPT` — order tasks by importance
- `SHOPPING_LABEL_SYSTEM_PROMPT` — classify items by store section

### `message-channel.ts`

Generic async iterable that buffers messages and yields them when the SDK calls `next()`. Used by the enrichment slot to reuse a single subprocess across multiple queries.

### `enrichment-slot.ts`

- `initEnrichmentSlot()` — warm up subprocess with MessageChannel
- `enrichmentQuery(prompt, options?)` — send query through warm slot (FIFO if busy)
- `getEnrichmentSlotStats()` — state, uptime, requests, recycles, model
- `shutdownEnrichmentSlot()` — graceful close for SIGTERM

### `sdk.ts`

- `initAI()` — called from `instrumentation.ts`, validates SDK
- `aiQuery(options)` — wraps SDK `query()` with error handling, timeout, semaphore, and activity logging
- `isAIEnabled()` — checks `OPENTASK_AI_ENABLED` env var

### `queue.ts`

- `acquireSlot()` / `releaseSlot()` — FIFO semaphore
- `withSlot(fn)` — convenience wrapper with automatic release
- `getQueueStats()` — returns active/waiting/max for monitoring

### `enrichment.ts`

- `enrichSingleTask(taskId, userId)` — on-demand enrichment via warm slot
- `processEnrichmentQueue()` — safety-net cron entry point with round-robin fairness, circuit breaker, shopping label integration
- `enrichTask(task, user)` — runs enrichment query through the warm slot
- `applyEnrichment(task, result, user)` — applies changes via `withTransaction()` + `logAction()`
- `resetStuckTasks()` — resets `'processing'` tasks to `'pending'` on startup

### `bubble.ts`

- `generateBubble(userId, timezone, tasks)` — surfaces overlooked tasks via per-query subprocess
- `getCachedBubble(userId)` — returns cached result from `ai_activity_log` if generated today
- Task selection scoring: high snooze count, no deadline, non-recurring (penalizes already-urgent tasks)

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

### Circuit breaker (enrichment queue)

The enrichment queue tracks rapid consecutive failures. If 5 tasks fail within 60 seconds, the queue pauses for 5 minutes and logs a warning. This prevents infinite failure loops when the underlying service is down.

### Circuit breaker (enrichment slot)

The warm enrichment slot tracks rapid consecutive recycles. If the slot recycles 5 times within 5 seconds, it is marked dead and no longer accepts queries. This prevents thrashing when the subprocess can't stay alive.

### Request timeout

Every SDK query has a configurable timeout (default 60 seconds). If the subprocess doesn't respond within the timeout, the `AbortController` kills it and the query returns an error.

### Stuck task detection

Each queue cycle checks for tasks stuck in `'processing'` for longer than 2 minutes. These are reset to `'pending'`. On server startup, `resetStuckTasks()` resets all `'processing'` tasks.

### Concurrent request limiting

The semaphore in `queue.ts` (default max 2) prevents resource exhaustion from multiple simultaneous per-query AI features. Queue waiters time out after 30 seconds. The warm enrichment slot uses its own FIFO queue.

### Round-robin fairness

The enrichment queue uses round-robin scheduling across users. Tasks from different users are interleaved, so no single user's backlog can starve others.

---

## Failure Modes

| Failure                        | What happens                                         | User sees                           |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------- |
| SDK not installed              | `isAIEnabled()` returns false                        | Nothing — app works normally        |
| Subprocess fails to start      | `ai_status` stays `'pending'`, retried next cycle    | Spinner continues                   |
| Subprocess hangs               | Timeout kills after 60s, `ai_status = 'failed'`      | Warning icon, raw text preserved    |
| Model returns invalid output   | `ai_status = 'failed'`, error logged                 | Warning icon, raw text preserved    |
| Model extracts wrong fields    | Changes applied and logged in undo                   | User can Cmd+Z to revert            |
| Server restarts mid-enrichment | `'processing'` tasks reset to `'pending'` on startup | Re-processed automatically          |
| Task has `ai-locked` label     | Enrichment skipped, `ai_status` set to null          | No AI processing                    |
| Rapid consecutive failures     | Circuit breaker pauses queue for 5 minutes           | Pending tasks wait                  |
| Enrichment slot dies           | Marked dead, queries throw error                     | Enrichment falls back to safety net |
| Semaphore full                 | Request queued FIFO, times out after 30 seconds      | Loading indicator, eventual error   |
| Bubble/triage cache hit        | Cached result returned immediately                   | Instant response                    |
| Briefing cache hit             | Cached result from activity log                      | Instant page load                   |

**No auto-retry on failure.** Failed tasks stay failed to prevent cost runaway.

---

## Feature Catalog

### Implemented

| Feature         | Description                                 | Model | Trigger               | Cache              |
| --------------- | ------------------------------------------- | ----- | --------------------- | ------------------ |
| Task enrichment | Parse natural language into structured task | Haiku | Task creation (async) | —                  |
| Bubble          | Surface easily overlooked tasks             | Haiku | 3 AM cron + on-demand | ai_activity_log    |
| Daily briefing  | Structured daily overview at /briefing      | Haiku | On-demand page load   | ai_activity_log 4h |
| AI triage       | Reorder tasks by AI-assessed importance     | Haiku | "AI Pick" filter chip | In-memory 5 min    |
| Shopping labels | Auto-label items by store section           | Haiku | During enrichment     | —                  |

### Considered / Deferred

| Feature      | Description                        | Model  | Status   |
| ------------ | ---------------------------------- | ------ | -------- |
| Chat sidebar | Conversational AI about your tasks | Sonnet | Deferred |

---

## Configuration

| Env var                               | Default | Description                                         |
| ------------------------------------- | ------- | --------------------------------------------------- |
| `OPENTASK_AI_ENABLED`                 | `false` | Master switch — all AI features disabled when false |
| `OPENTASK_AI_ENRICHMENT_MODEL`        | `haiku` | Model for task enrichment                           |
| `OPENTASK_AI_MAX_REUSES`              | `8`     | Max queries per warm enrichment subprocess          |
| `OPENTASK_AI_BUBBLE_MODEL`            | `haiku` | Model for Bubble recommendations                    |
| `OPENTASK_AI_BRIEFING_MODEL`          | `haiku` | Model for daily briefing                            |
| `OPENTASK_AI_TRIAGE_MODEL`            | `haiku` | Model for AI triage                                 |
| `OPENTASK_AI_SHOPPING_MODEL`          | `haiku` | Model for shopping label classification             |
| `OPENTASK_AI_QUERY_TIMEOUT_MS`        | `60000` | Timeout for SDK queries in milliseconds             |
| `OPENTASK_AI_CLI_PATH`                | (auto)  | Path to Claude Code CLI executable                  |
| `OPENTASK_AI_MAX_CONCURRENT`          | `2`     | Maximum concurrent SDK subprocesses (per-query)     |
| `OPENTASK_AI_QUEUE_TIMEOUT_MS`        | `30000` | Maximum wait time for semaphore slot                |
| `OPENTASK_RETENTION_AI_ACTIVITY_DAYS` | `90`    | Days to retain AI activity log entries              |

No API key needed — the SDK uses Claude Code's authentication on the server.

---

## Activity Logging

Every AI operation is logged in the `ai_activity_log` table:

| Column        | Type    | Description                                                                          |
| ------------- | ------- | ------------------------------------------------------------------------------------ |
| `id`          | INTEGER | Primary key                                                                          |
| `user_id`     | INTEGER | Who owns the task                                                                    |
| `task_id`     | INTEGER | Which task (nullable for non-task operations)                                        |
| `action`      | TEXT    | Operation type: `'enrich'`, `'bubble'`, `'briefing'`, `'triage'`, `'shopping_label'` |
| `status`      | TEXT    | `'success'`, `'error'`, `'skipped'`                                                  |
| `input`       | TEXT    | Raw input (e.g., original task text)                                                 |
| `output`      | TEXT    | JSON result from AI                                                                  |
| `model`       | TEXT    | Which model was used                                                                 |
| `duration_ms` | INTEGER | How long the query took                                                              |
| `error`       | TEXT    | Error message if failed                                                              |
| `created_at`  | TEXT    | ISO 8601 timestamp                                                                   |

The briefing and Bubble features use this table for cache persistence.

The History → AI tab shows enrichment slot status and recent activity entries for debugging and observability.

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
