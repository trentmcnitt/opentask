# AI Integration — Design Document

_Version 1.0 — 2026-03_

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
10. [Quality Testing](#quality-testing)

---

## Principles

### Certainty first

The task is always saved before AI is consulted. If the user types "call dentist next Tuesday high priority" and presses Enter, the task exists in the database within milliseconds. AI enrichment happens asynchronously — if it fails, the raw text is preserved exactly as typed. The user never loses data because of an AI failure.

### Transcriptionist, not editor

The enrichment prompt treats user input as dictation to be cleaned, not prose to be rewritten. Clean up: artifacts, rambling, repetition, false starts. Preserve exactly: word choices, framing, specific claims. Never add concepts the user didn't use.

This is especially important because users often dictate tasks while driving or multitasking — input may be garbled, stream-of-consciousness, or oddly phrased.

### Graceful failure

There are two distinct failure modes:

1. **Request failed in chain** — the provider returned an error, the model timed out, the response was malformed. The task is untouched, the `ai-failed` label is applied, and the error is logged. The user sees a warning icon on the task but their raw text is intact.

2. **AI did something wrong** — the model returned valid JSON but extracted the wrong priority, misunderstood the due date, or assigned the wrong project. The changes were applied and logged in the undo system. The user can Cmd+Z (or tap undo) to revert all AI changes atomically.

Both failure modes must be handled. The system must never silently corrupt data.

### Undo integration

Every AI mutation is logged through the existing undo system using the standard `logAction()` + `createTaskSnapshot()` pattern. AI changes use the `'edit'` action type with AI-prefixed descriptions (e.g., "AI: Enriched task — set title, due date, priority"). This means:

- AI changes appear in the undo history alongside manual edits
- Cmd+Z reverts the entire AI enrichment atomically
- The history page shows what AI changed and when

### Right model for the job

Different features have different latency and intelligence requirements:

| Use case    | Default model | Why                                    |
| ----------- | ------------- | -------------------------------------- |
| Enrichment  | Haiku         | Fast, cheap, structured extraction     |
| Quick Take  | Sonnet        | Needs awareness of task list context   |
| What's Next | Haiku         | Infrequent, 3 AM cron + on-demand      |
| Insights    | Opus          | Needs deep analysis, extended thinking |

Every feature resolves its model via `requireFeatureModel()`, which checks per-feature env vars first, then falls back to provider-level defaults. See [Configuration](#configuration).

### Give AI the fullest picture possible

Only filter things that are truly safe to filter (like tasks due far in the future). The more context AI has, the better its insights. For example, the What's Next prompt includes `rrule`, `notes`, and `recurrence_mode` — not just `recurring: yes/no` — because the pattern (daily vs monthly), the context (notes from dictation), and the advancement mode (from_due vs from_completion) all affect how the AI should interpret a task's state.

### AI-locked protection

Tasks with the `ai-locked` label are never processed by AI. This gives users an escape hatch for tasks they want to keep exactly as written. The queue checks for this label and skips the task (removing AI processing labels).

---

## Architecture

### Three providers

The AI system supports three backends, selectable per-user per-feature:

| Provider  | Backend                       | Requirements                                    | Use case                                              |
| --------- | ----------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| SDK       | Claude Agent SDK (subprocess) | Claude Code installed + authenticated           | Self-hosted with Max subscription                     |
| Anthropic | Anthropic Messages API (HTTP) | `ANTHROPIC_API_KEY`                             | Docker, no Claude Code needed                         |
| OpenAI    | OpenAI-compatible API (HTTP)  | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) | OpenAI, OpenRouter, Ollama, Groq, xAI, DeepSeek, etc. |

Provider resolution order:

1. Per-feature mode (`off` / `sdk` / `api`) — stored per user in the database
2. For `api` mode, `OPENTASK_AI_PROVIDER` env var determines which HTTP backend
3. Auto-detection: Anthropic → OpenAI (first available API key wins)

All three providers share the same `AIQueryResult` interface, so callers never need to know which backend is in use.

### AI query dispatcher

`aiQuery()` in `sdk.ts` is the central dispatch point for all AI queries. Based on the `provider` option (or server default), it routes to:

- `sdkQuery()` — spawns a Claude Code subprocess via the Claude Agent SDK
- `apiQuery()` — calls the Anthropic Messages API via `@anthropic-ai/sdk`
- `openaiQuery()` — calls an OpenAI-compatible chat completions API via `openai`

Each provider handles structured output, timeout, error logging, and activity logging uniformly.

### Warm slots (SDK only)

The SDK provider uses warm subprocess slots for latency-sensitive features. A warm slot keeps a Claude Code subprocess alive across multiple requests via the MessageChannel pattern, eliminating cold-start latency.

There are two warm slots:

**1. Enrichment slot** (`enrichment-slot.ts`): FIFO queue — requests wait in order for the single subprocess. After `MAX_REUSES` (default 8) results, the slot recycles (closes old subprocess, starts a new one). Circuit breaker: 5 recycles in 5 seconds marks the slot as dead.

**2. Quick Take slot** (`quick-take-slot.ts`): Latest-wins cancellation — only the most recent quick take matters, so new requests supersede in-flight ones. Lower max reuses (default 4) since quick takes are less frequent.

API providers (Anthropic, OpenAI) make stateless HTTP calls and do not use warm slots.

### On-demand enrichment

Task enrichment is on-demand: when a task is created, the API route fires and forgets `enrichSingleTask()` which sends the query through the warm enrichment slot (SDK) or a direct API call (Anthropic/OpenAI). A 1-minute safety-net cron (`processEnrichmentQueue()`) picks up any tasks with the `ai-to-process` label that the on-demand path missed.

```
User types → Task saved immediately → `ai-to-process` label added
                                           ↓
                                    Fire-and-forget enrichSingleTask()
                                           ↓
                                    Provider query (slot or API)
                                           ↓
                                  ┌─── Success ───┐── Failure ──┐
                                  ↓                              ↓
                          Apply changes              Retry tracking
                          Log for undo               (2 attempts, then
                          `ai-to-process` removed     `ai-failed` label)
```

Safety net: cron runs every 1 minute, picks up pending tasks with round-robin fairness across users.

### Shared project support

Enrichment queries both owned and shared projects when building the project list for AI. This allows the model to route tasks to shared projects. The project list format indicates which projects are shared:

```
- Inbox (id: 1)
- Shopping List (id: 5, shared)
```

### Per-user feature modes

Each user has per-feature AI mode settings stored in the database:

- `off` — feature disabled for this user
- `sdk` — use Claude Agent SDK (subprocess)
- `api` — use the server's configured API provider (Anthropic or OpenAI)

Feature modes are read by `getUserFeatureModes()` and checked at the start of each AI operation.

### Concurrent request management

A semaphore in `queue.ts` limits concurrent SDK subprocesses (default: 4). All per-query AI operations (What's Next, Insights) acquire a slot before spawning a subprocess. The warm enrichment and quick take slots operate independently and do not use the semaphore.

---

## Module Structure

All AI code lives in `src/core/ai/`:

```
src/core/ai/
├── index.ts            — Barrel exports
├── types.ts            — TypeScript types and Zod schemas
├── activity.ts         — Activity log read/write
├── prompts.ts          — System prompts for each feature (enrichment, whats_next, insights)
├── sdk.ts              — Central query dispatcher, SDK provider, init, isAIEnabled()
├── api-provider.ts     — Anthropic Messages API provider
├── openai-provider.ts  — OpenAI-compatible API provider
├── provider.ts         — Provider detection, resolution, model name mapping
├── models.ts           — Centralized model resolution per feature + provider
├── queue.ts            — Concurrent request semaphore (FIFO, configurable limit)
├── parse-helpers.ts    — Shared JSON extraction from text responses
├── message-channel.ts  — Async iterable for subprocess communication
├── slot-shared.ts      — Shared utilities for warm slot infrastructure
├── enrichment-slot.ts  — Warm SDK slot for enrichment (MessageChannel + consumer + lifecycle)
├── enrichment-api.ts   — API-mode enrichment query (Anthropic/OpenAI, no warm slot)
├── enrichment.ts       — Task enrichment pipeline (on-demand + safety-net cron)
├── quick-take.ts       — Quick Take prompt building and generation
├── quick-take-slot.ts  — Warm SDK slot for Quick Take (latest-wins cancellation)
├── whats-next.ts       — What's Next recommendations (surfaces overlooked tasks)
├── insights.ts         — AI Insights batch scoring, signals, and session management
├── format.ts           — Shared task formatting for AI prompts
├── user-context.ts     — User AI context and per-feature mode preferences
├── task-summaries.ts   — Compact task data builder for AI prompts
└── purge.ts            — Activity log data retention
```

### `types.ts`

- `EnrichmentResultSchema` — Zod schema for task enrichment output (title, due_at, priority, labels, project_name, rrule, auto_snooze_minutes, recurrence_mode, notes, reasoning)
- `WhatsNextResultSchema` — surfaced tasks + reasons + summary
- `InsightsItemSchema` / `InsightsBatchResultSchema` — per-task score, commentary, and signals
- `TaskSummary` — compact task representation for AI prompts
- `AIActivityEntry` — shape of activity log rows

### `prompts.ts`

- `ENRICHMENT_SYSTEM_PROMPT` — task parsing with transcriptionist philosophy
- `WHATS_NEXT_SYSTEM_PROMPT` — surface overlooked tasks (social obligations, snoozed items, idle tasks)
- `INSIGHTS_SYSTEM_PROMPT` — batch task scoring and signal detection
- `ENRICHMENT_REMINDERS` / `WHATS_NEXT_REMINDERS` / `INSIGHTS_REMINDERS` — closing reinforcement blocks for each prompt

Quick Take uses its own system prompt (`QUICK_TAKE_SYSTEM_PROMPT`) defined in `quick-take.ts` because it is split into static (system) and dynamic (user) parts for the warm slot.

### `sdk.ts`

- `isAIEnabled()` — checks `OPENTASK_AI_ENABLED` env var
- `initAI()` — called from `instrumentation.ts`, detects providers, validates config
- `aiQuery(options)` — central dispatch to SDK/Anthropic/OpenAI with unified result shape
- `handleQueryError()` — shared error handler for all providers

### `api-provider.ts`

- `apiQuery(options)` — Anthropic Messages API provider. Supports structured output via `output_config`, extended thinking for Opus models. Sanitizes JSON schemas for Anthropic compatibility.

### `openai-provider.ts`

- `openaiQuery(options)` — OpenAI-compatible provider. Supports structured output via `response_format.json_schema`, wraps array schemas in objects for API compatibility. Works with OpenAI, OpenRouter, Ollama, Together, Groq, xAI, DeepSeek, and any OpenAI-compatible endpoint.

### `provider.ts`

- `isSdkAvailable()` / `isSdkAvailableSync()` — detect Claude Agent SDK
- `isAnthropicAvailable()` / `isOpenAIAvailable()` — check for API keys
- `getServerDefaultProvider()` — resolve default from env var or auto-detect
- `getApiProvider()` — resolve which HTTP backend for `api` mode
- `resolveModelId()` — map short names (haiku, sonnet, opus) to full Anthropic model IDs

### `models.ts`

- `resolveFeatureModel(feature, provider)` — resolve model for a feature: per-feature env var → provider default
- `requireFeatureModel(feature, provider)` — same but throws on null
- `getFeatureInfo(feature, mode)` — full display info for UI (model name, provider, availability)

### `enrichment-slot.ts`

- `initEnrichmentSlot()` — warm up subprocess with MessageChannel
- `enrichmentQuery(prompt, options?)` — send query through warm slot (FIFO if busy)
- `getEnrichmentSlotStats()` — state, uptime, requests, recycles, model
- `shutdownEnrichmentSlot()` — graceful close for SIGTERM

### `enrichment-api.ts`

- `enrichmentApiQuery(prompt, options?)` — stateless HTTP enrichment via Anthropic or OpenAI API

### `enrichment.ts`

- `enrichSingleTask(taskId, userId)` — on-demand enrichment (fire-and-forget from task creation)
- `processEnrichmentQueue()` — safety-net cron entry point with round-robin fairness, circuit breaker
- `enrichTask(task, user)` — runs enrichment query through warm slot or API
- `applyEnrichment(task, result, user)` — applies changes via `withTransaction()` + `logAction()`
- `filterExplicitLabels()` — post-parse guard that strips AI-inferred labels unless the user's input contains explicit label-intent language

### `quick-take.ts`

- `generateQuickTake(userId, timezone, newTaskTitle)` — generate a one-liner showing awareness of the user's task list. Tries the warm slot first (SDK), falls back to cold `aiQuery()` path.
- `buildQuickTakePrompt()` / `buildQuickTakeUserPrompt()` — prompt builders exported for testing and `dump-prompts`
- `formatCompactTaskList()` / `buildTaskStats()` — precompute statistics so the model never counts

### `quick-take-slot.ts`

- `initQuickTakeSlot()` — warm up subprocess with MessageChannel
- `quickTakeSlotQuery(prompt, options?)` — latest-wins: new requests supersede in-flight ones
- `getQuickTakeSlotStats()` — state, uptime, requests, recycles, superseded count
- `shutdownQuickTakeSlot()` — graceful close for SIGTERM

### `whats-next.ts`

- `generateWhatsNext(userId, timezone, tasks)` — surfaces overlooked tasks via per-query call
- `getCachedWhatsNext(userId)` — returns cached result from `ai_activity_log` if generated today
- Task selection: includes tasks due within 7 days, overdue, or with no due date

### `insights.ts`

- `startInsightsGeneration(userId, timezone, tasks)` — fire-and-forget background generation with session tracking
- `generateInsightsForUser(userId, timezone, tasks)` — blocking generation (used by nightly cron)
- `getInsightsSessionStatus()` / `getInsightsResults()` / `hasInsightsResults()` — retrieval and polling
- `sanitizeSignals()` — defense-in-depth enforcement of signal rules (P4 score ceiling, act_soon requires P3+, stale requires 21+ days old)
- `INSIGHTS_SIGNALS` / `SIGNAL_MAP` — signal vocabulary with display properties (label, color, icon)
- Chunking: single call for ≤500 tasks, shuffled equal chunks for larger lists with calibration summary

### `message-channel.ts`

Generic async iterable that buffers messages and yields them when the SDK calls `next()`. Used by both warm slots to reuse a single subprocess across multiple queries.

### `slot-shared.ts`

Shared utilities for warm slot infrastructure: `SlotState` type, `BaseSlotStats` interface, warmup validation, env var parsing, circuit breaker check. Used by both enrichment-slot and quick-take-slot.

### `queue.ts`

- `acquireSlot()` / `releaseSlot()` — FIFO semaphore
- `withSlot(fn)` — convenience wrapper with automatic release
- `getQueueStats()` — returns active/waiting/max for monitoring

### `format.ts`

- `formatLocalDate()` — ISO UTC to human-readable local time
- `formatAge()` — pre-computed age string (prevents AI hallucination)
- `formatTaskLine()` — consistent one-line task format for AI prompts
- `getScheduleBlock()` — user's wake/sleep schedule for prompts

### `parse-helpers.ts`

- `parseAIResponse()` — generic parser: structured output → text JSON fallback → Zod validation
- `extractJsonFromText()` — extract JSON from markdown code blocks or bare text

### `task-summaries.ts`

- `buildTaskSummaries(userId)` — fetch active tasks with project names in a single bulk query

---

## Robustness

### Circuit breaker (enrichment queue)

The enrichment queue tracks rapid consecutive failures. If 5 tasks fail within 60 seconds, the queue pauses for 5 minutes and logs a warning. This prevents infinite failure loops when the underlying service is down.

### Circuit breaker (warm slots)

Both warm slots track rapid consecutive recycles. If a slot recycles 5 times within 5 seconds, it is marked dead and no longer accepts queries. This prevents thrashing when the subprocess can't stay alive.

### Request timeout

Every AI query has a configurable timeout (default 60 seconds). If the provider doesn't respond within the timeout, the `AbortController` kills the request and the query returns an error. Insights uses a longer timeout (15 minutes) to accommodate Opus with extended thinking on large task lists.

### Retry tracking

Enrichment uses in-memory retry tracking (taskId → attempt count). On first failure, the task retries on the next cycle. On second failure, the `ai-to-process` label is swapped for `ai-failed`. Retry state resets on server restart, giving tasks fresh attempts.

### Concurrent request limiting

The semaphore in `queue.ts` (default max 4) prevents resource exhaustion from multiple simultaneous SDK subprocesses. Queue waiters time out after 30 seconds. The warm slots use their own concurrency models (FIFO for enrichment, latest-wins for quick take).

### Round-robin fairness

The enrichment queue uses round-robin scheduling across users. Tasks from different users are interleaved, so no single user's backlog can starve others.

---

## Failure Modes

| Failure                        | What happens                                        | User sees                         |
| ------------------------------ | --------------------------------------------------- | --------------------------------- |
| No provider available          | `isAIEnabled()` set to false, AI disabled           | Nothing — app works normally      |
| API key invalid                | Provider returns 401, logged as error               | Warning icon, raw text preserved  |
| Provider request fails         | `ai-to-process` label stays, retried next cycle     | Spinner continues                 |
| Provider hangs                 | Timeout kills after 60s, retry tracking incremented | Warning icon after 2nd failure    |
| Model returns invalid output   | `ai-failed` label applied after 2 attempts          | Warning icon, raw text preserved  |
| Model extracts wrong fields    | Changes applied and logged in undo                  | User can Cmd+Z to revert          |
| Server restarts mid-enrichment | In-memory processing set resets, tasks retried      | Re-processed automatically        |
| Task has `ai-locked` label     | Enrichment skipped, `ai-to-process` removed         | No AI processing                  |
| Rapid consecutive failures     | Circuit breaker pauses queue for 5 minutes          | Pending tasks wait                |
| Warm slot dies                 | Marked dead, API mode falls back to cold path       | Slightly slower enrichment        |
| Semaphore full                 | Request queued FIFO, times out after 30 seconds     | Loading indicator, eventual error |
| What's Next cache hit          | Cached result returned immediately                  | Instant response                  |
| Insights session crash         | Stale session auto-failed after 20 minutes          | User can re-trigger               |

**No auto-retry on failure.** Failed tasks stay failed (after 2 attempts) to prevent cost runaway.

---

## Feature Catalog

| Feature     | Description                                          | Default model | Trigger                                 | Cache                    |
| ----------- | ---------------------------------------------------- | ------------- | --------------------------------------- | ------------------------ |
| Enrichment  | Parse natural language into structured task          | Haiku         | Task creation (async)                   | —                        |
| Quick Take  | One-liner commentary on task creation                | Sonnet        | Task creation (async, after enrichment) | —                        |
| What's Next | Surface easily overlooked tasks                      | Haiku         | 3 AM cron + on-demand                   | ai_activity_log (daily)  |
| Insights    | Batch task scoring, commentary, and signal detection | Opus          | On-demand + nightly cron                | ai_insights_results (DB) |

### Enrichment

Parses natural language task input into structured fields: clean title, due date, priority, labels, project, recurrence rule, auto-snooze, recurrence mode, and notes. Runs asynchronously after task creation. Uses the warm enrichment slot (SDK) or a direct API call (Anthropic/OpenAI).

Extracted labels pass through `filterExplicitLabels()` — a post-parse guard that strips AI-inferred labels unless the user's input contains explicit label-intent language (e.g., "label it", "tag it", "mark it as").

### Quick Take

Generates a snappy one-liner after task quick-add, showing awareness of the user's existing tasks. Cross-references when relevant ("3 Acme tasks this week — this makes it a theme") or gives a brief observation.

The prompt is split into a static system prompt (loaded once at slot init) and a dynamic user prompt (pushed per request). Statistics are precomputed in code (due today, due this week, by project, by label, busiest day) so the model reads numbers rather than scanning the task list itself.

### What's Next

Helps the user decide what to focus on — surfacing tasks that deserve attention, are easy to forget, or represent opportunities for progress. Filters to tasks due within 7 days, overdue, or undated. Results cached in `ai_activity_log` for same-day retrieval.

### Insights

Batch-processes the user's entire task list, scoring each task 0-100 based on how much it needs attention. Each task gets one-line commentary and 0-2 signals from a preset vocabulary:

| Signal           | Description                              |
| ---------------- | ---------------------------------------- |
| `review`         | Worth a closer look                      |
| `stale`          | Sitting for weeks, might not be relevant |
| `act_soon`       | Window closing, time-sensitive           |
| `quick_win`      | Small task, easy to knock out            |
| `vague`          | Unclear what this requires               |
| `misprioritized` | Priority seems off for what this is      |

Code-enforced signal rules (defense-in-depth): P4 scores capped at 25, `act_soon` requires P3+, `stale` requires 21+ days old. Lists over 500 tasks are shuffled and split into equal chunks, each with a calibration summary of the full list. Extended thinking enabled for Opus models.

---

## Configuration

### Master switch

| Env var               | Default | Description                                         |
| --------------------- | ------- | --------------------------------------------------- |
| `OPENTASK_AI_ENABLED` | `false` | Master switch — all AI features disabled when false |

### Provider selection

| Env var                | Default                     | Description                                                   |
| ---------------------- | --------------------------- | ------------------------------------------------------------- |
| `OPENTASK_AI_PROVIDER` | (auto-detect)               | `anthropic` or `openai`. Auto-detects from available API keys |
| `ANTHROPIC_API_KEY`    | —                           | Required for Anthropic API mode                               |
| `OPENAI_API_KEY`       | —                           | Required for OpenAI-compatible mode                           |
| `OPENAI_BASE_URL`      | `https://api.openai.com/v1` | Override for non-OpenAI endpoints (Ollama, Groq, etc.)        |
| `OPENAI_MODEL`         | —                           | Default model for all features when using OpenAI (required)   |

### Per-feature models

| Env var                        | SDK/Anthropic default | OpenAI default | Description               |
| ------------------------------ | --------------------- | -------------- | ------------------------- |
| `OPENTASK_AI_ENRICHMENT_MODEL` | `haiku`               | `OPENAI_MODEL` | Model for task enrichment |
| `OPENTASK_AI_QUICKTAKE_MODEL`  | `sonnet`              | `OPENAI_MODEL` | Model for Quick Take      |
| `OPENTASK_AI_WHATS_NEXT_MODEL` | `haiku`               | `OPENAI_MODEL` | Model for What's Next     |
| `OPENTASK_AI_INSIGHTS_MODEL`   | `claude-opus-4-6`     | `OPENAI_MODEL` | Model for Insights        |

Short names (`haiku`, `sonnet`, `opus`) are mapped to full Anthropic model IDs automatically. OpenAI model strings pass through as-is.

### SDK-specific settings

These only apply when using the Claude Agent SDK (subprocess) provider:

| Env var                            | Default | Description                                     |
| ---------------------------------- | ------- | ----------------------------------------------- |
| `OPENTASK_AI_MAX_REUSES`           | `8`     | Max queries per warm enrichment subprocess      |
| `OPENTASK_AI_QUICKTAKE_MAX_REUSES` | `4`     | Max queries per warm quick take subprocess      |
| `OPENTASK_AI_QUICKTAKE_TIMEOUT_MS` | `40000` | Timeout for quick take queries in milliseconds  |
| `OPENTASK_AI_CLI_PATH`             | (auto)  | Path to Claude Code CLI executable              |
| `OPENTASK_AI_MAX_CONCURRENT`       | `4`     | Maximum concurrent SDK subprocesses (per-query) |
| `OPENTASK_AI_QUEUE_TIMEOUT_MS`     | `30000` | Maximum wait time for semaphore slot            |

### Shared settings

| Env var                               | Default | Description                                    |
| ------------------------------------- | ------- | ---------------------------------------------- |
| `OPENTASK_AI_QUERY_TIMEOUT_MS`        | `60000` | Default timeout for AI queries (all providers) |
| `OPENTASK_RETENTION_AI_ACTIVITY_DAYS` | `90`    | Days to retain AI activity log entries         |

### Quick-start examples

```bash
# Anthropic API (recommended — uses Haiku/Sonnet/Opus per feature)
OPENTASK_AI_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-api03-...

# OpenAI
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini

# xAI (Grok)
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=xai-...
OPENAI_BASE_URL=https://api.x.ai/v1
OPENAI_MODEL=grok-4-1-fast

# Ollama (local, free)
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1

# Claude Code SDK (no API key needed — uses your Claude Code auth)
OPENTASK_AI_ENABLED=true
```

---

## Activity Logging

Every AI operation is logged in the `ai_activity_log` table:

| Column        | Type    | Description                                                              |
| ------------- | ------- | ------------------------------------------------------------------------ |
| `id`          | INTEGER | Primary key                                                              |
| `user_id`     | INTEGER | Who owns the task                                                        |
| `task_id`     | INTEGER | Which task (nullable for non-task operations)                            |
| `action`      | TEXT    | Operation type: `'enrich'`, `'whats_next'`, `'insights'`, `'quick_take'` |
| `status`      | TEXT    | `'success'`, `'error'`, `'skipped'`                                      |
| `input`       | TEXT    | Raw input (e.g., original task text)                                     |
| `output`      | TEXT    | JSON result from AI                                                      |
| `model`       | TEXT    | Which model was used                                                     |
| `duration_ms` | INTEGER | How long the query took                                                  |
| `error`       | TEXT    | Error message if failed                                                  |
| `provider`    | TEXT    | Which provider was used: `'sdk'`, `'anthropic'`, `'openai'`              |
| `created_at`  | TEXT    | ISO 8601 timestamp                                                       |

The What's Next feature uses this table for cache persistence.

The History page shows AI activity entries for debugging and observability.

---

## Data Retention

| Data            | Retention | Purge schedule        | Env var override                      |
| --------------- | --------- | --------------------- | ------------------------------------- |
| Undo log        | 30 days   | Daily at 3:00 AM      | `OPENTASK_RETENTION_UNDO_DAYS`        |
| Trash           | 30 days   | Daily at 3:30 AM      | `OPENTASK_RETENTION_TRASH_DAYS`       |
| Completions     | 30 days   | Daily at 4:00 AM      | `OPENTASK_RETENTION_COMPLETIONS_DAYS` |
| Daily stats     | 365 days  | Weekly Sunday 4:30 AM | `OPENTASK_RETENTION_STATS_DAYS`       |
| AI activity log | 90 days   | Daily at 5:00 AM      | `OPENTASK_RETENTION_AI_ACTIVITY_DAYS` |

AI activity has a longer retention than other data because it's useful for prompt tuning and cost analysis.

---

## Quality Testing

### Why quality testing is critical

**Production has no feedback loop for AI quality.** There is no user rating system, no A/B testing, no telemetry on whether the AI is producing good results in the field. The quality test suite is the _only_ mechanism for measuring and maintaining AI output quality.

This means the AI will only perform as well as our tests prove it can. Quality is a function of two things:

1. **How extensive and realistic the test scenarios are.** Scenarios must cover the full range of real-world inputs: garbled dictation, typos, edge cases, ambiguous phrasing, colloquial language, and every field combination. Coverage gaps are quality gaps — if a pattern isn't tested, assume it doesn't work correctly.

2. **How well the AI holds up under that realistic testing.** Every scenario is evaluated against a rubric, and any score below 6 means the prompt needs iteration. Prompt changes that degrade quality on existing scenarios must not ship.

When modifying prompts or enrichment logic: run both layers on ALL scenarios, not just new ones. Regressions are easy to introduce and hard to detect without full coverage.

### Layer 1 — Automated generation + structural validation

Runs each test scenario through the real AI (same production code paths). Validates that outputs parse correctly, schemas validate, and required fields are present. Saves inputs, outputs, and requirements to `test-results/quality-{timestamp}/`.

```bash
npm run test:quality
```

**Requirements:** `OPENTASK_AI_ENABLED=true` and an AI provider configured.

If AI is not enabled, all tests skip gracefully (no errors).

### Layer 2 — Quality evaluation by Claude

After Layer 1 completes, it prints instructions to stdout. The evaluating agent (Claude in-session) reads the saved artifacts and judges output quality against criteria in `tests/quality/validator-prompt.md`.

For each scenario, the evaluator writes a `validation.md` with a score (0-10), pass/fail, and per-criterion results. A `layer2-summary.md` summarizes the full run.

### Testing philosophy

- **Coverage = quality.** If a pattern isn't tested, assume it doesn't work correctly. Scenarios must cover the full range of real-world inputs: dictation artifacts (Siri homophones, garbled speech, run-togethers), edge cases, ambiguous phrasing, and every field combination.
- **Both layers are necessary.** Layer 1 catches structural regressions (broken JSON, missing fields, schema violations). Layer 2 catches quality regressions (wrong scores, bad commentary, misapplied signals). Skipping Layer 2 means shipping blind.
- **Realism is non-negotiable.** The task generator produces task lists with realistic distributions: semantic labels (not random), dictation artifact titles (~3-5%), notes on 10-15% of tasks, snoozed tasks with `due_at !== original_due_at`, diverse time-of-day ranges, and full life-domain coverage. Sanitized, uniform test data gives false confidence.
- **`insights_expectations` enforce hard rules.** Machine-checkable score ranges and signal checks catch deterministic regressions automatically in Layer 1. `quality_notes` capture the subjective expectations for Layer 2. Both are needed — expectations catch the easy regressions, quality notes catch the nuanced ones.
- **Signal restraint is a core quality metric.** 60-70% of tasks should receive zero signals. Over-signaling is as bad as under-signaling — it makes the signal noise, not information. The `min_zero_signal_pct` expectation enforces this.
- **When to add scenarios:** Any new AI behavior, any prompt change, any new signal or scoring rule. Untested behavior is unverified behavior. Run both layers on ALL scenarios after changes, not just new ones.

### Scenario organization

Scenarios live in `tests/quality/scenarios/`, organized by category:

| File                        | Category                                               | Count |
| --------------------------- | ------------------------------------------------------ | ----- |
| `enrichment-core.ts`        | Core enrichment (title, date, priority, etc.)          | 32    |
| `enrichment-labels.ts`      | Explicit-only label extraction                         | 10    |
| `enrichment-dictation.ts`   | Dictation realism and typo tolerance                   | 10    |
| `enrichment-recurrence.ts`  | Expanded recurrence patterns                           | 10    |
| `enrichment-voice.ts`       | Voice preservation                                     | 8     |
| `enrichment-edge.ts`        | Edge cases                                             | 10    |
| `whats-next.ts`             | What's Next recommendations                            | 8     |
| `insights.ts`               | AI Insights scoring and signals                        | 11    |
| `insights-large.ts`         | Large-scale insights (50-600 tasks, production)        | 3     |
| `helpers/generate-tasks.ts` | Realistic task list generator (used by insights-large) | —     |
| `index.ts`                  | Barrel export                                          | —     |

**Total: 102 scenarios** (80 enrichment + 8 whats_next + 14 insights)

Each scenario defines:

- `id` — unique identifier (e.g., `enrich-garbled-dictation`)
- `feature` — which AI feature (`enrichment`, `whats_next`, `insights`)
- `input` — feature-specific input data
- `requirements` — structural checks (`must_include`, `must_not_include`) and qualitative notes (`quality_notes`)

When adding new AI behavior, always add scenarios that test it. Untested behavior is unverified behavior.

### How to adjust evaluation criteria

Edit `tests/quality/validator-prompt.md`. The rubric is organized by feature with specific criteria for each.

### Key files

| File                                | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `tests/quality/types.ts`            | Type definitions for scenarios, inputs, outputs    |
| `tests/quality/scenarios/`          | Test scenario definitions (102 scenarios)          |
| `tests/quality/ai-quality.test.ts`  | Layer 1 runner (vitest)                            |
| `tests/quality/validator-prompt.md` | Layer 2 judge rubric                               |
| `vitest.quality.config.ts`          | Separate vitest config (long timeouts, sequential) |
