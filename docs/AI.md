# AI Integration — Design Document

_Version 1.0 — 2026-03_

This is the authoritative reference for AI integration in OpenTask. It covers principles, architecture, failure handling, and the feature catalog.

> **SHELVED (2026-10-22, Trent): What's Next, Insights and Quick Take.** The whole set is shelved until it is redesigned; **enrichment and Process are the AI features that run**. Process's on-demand AI suggestions (`process.ts`) are NOT shelved: Process is its own AI feature with its own mode (`ai_process_mode`, the Process row in Settings → AI), shown and running whatever the switch says (see [Process](#process)). One server-wide switch, `OPENTASK_AI_UNSHELVE=1`, brings all three back. Unset (the default, and production):
>
> - the 03:00 What's Next and 03:30 Insights jobs are never scheduled (`src/instrumentation.ts` logs one line, "What's Next and Insights are shelved (OPENTASK_AI_UNSHELVE unset)"), and `runScheduledWhatsNext` / `runScheduledInsights` return at once;
> - `GET /api/ai/whats-next`, `POST /api/ai/insights/generate`, `GET /api/ai/insights/results`, `GET /api/ai/insights/status`, `POST /api/ai/quick-take`, and `POST /api/ai/test` for those three features answer `410 { "error": "What's Next, Insights and Quick Take are shelved", "code": "FEATURE_SHELVED" }` (after auth, before the AI-enabled check);
> - `GET /api/user/preferences` reports `ai_unshelved: false`; the web hides the dashboard's AI chip, the What's Next and Insights filter chips, score and signal chips, row commentary and highlights, the AI Score sort, the Quick Take banner (a quick add is the plain create), their rows in Settings → AI and AI Status, and the demo tour's Insights steps;
> - their quality scenarios are skipped (`OPENTASK_AI_ENABLED=true OPENTASK_AI_UNSHELVE=1 npm run test:quality` includes them).
>
> Nothing writes a user's `ai_*_mode` or view preferences, so the switch restores exactly what each user had. Quick Take never shared a call, prompt or code path with enrichment: the dashboard created the task (the server queues enrichment) and then made a separate `POST /api/ai/quick-take`; shelved, only that second call and its banner are gone. Process read the **Insights** mode until 2026-10-22 — with that row hidden, nobody could turn Process on — so it got its own mode the same day (Trent: keep Process AI).
>
> The code below stays in place, dormant, with `SHELVED (2026-10-22)` headers. **Do not "fix", re-enable or delete it without Trent.** Switch: `src/core/ai/shelved.ts`.

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

---

## Architecture

### Three providers

The AI system supports three backends, selectable per-user per-feature:

| Provider  | Backend                       | Requirements                                    | Use case                                              |
| --------- | ----------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| SDK       | Claude Agent SDK (subprocess) | Claude Code ≥ 2.1.101 installed + logged in     | Self-hosted with Max subscription                     |
| Anthropic | Anthropic Messages API (HTTP) | `ANTHROPIC_API_KEY`                             | Docker, no Claude Code needed                         |
| OpenAI    | OpenAI-compatible API (HTTP)  | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) | OpenAI, OpenRouter, Ollama, Groq, xAI, DeepSeek, etc. |

Provider resolution order:

1. Per-feature mode (`off` / `sdk` / `api`) — stored per user in the database
2. For `api` mode, `OPENTASK_AI_PROVIDER` env var determines which HTTP backend
3. Auto-detection: Anthropic → OpenAI (first available API key wins)

All three providers share the same `AIQueryResult` interface, so callers never need to know which backend is in use.

**SDK mode requires an installed, logged-in Claude Code, version 2.1.101 or newer.** OpenTask never runs the CLI bundled inside the Agent SDK package. Running in Docker, or anywhere without Claude Code? Use an API provider (`OPENTASK_AI_PROVIDER=anthropic` or `openai`); those never look for the CLI. See [Which Claude Code CLI runs](#which-claude-code-cli-runs).

### AI query dispatcher

`aiQuery()` in `sdk.ts` is the central dispatch point for all AI queries. Based on the `provider` option (or server default), it routes to:

- `sdkQuery()` — spawns a Claude Code subprocess via the Claude Agent SDK
- `apiQuery()` — calls the Anthropic Messages API via `@anthropic-ai/sdk`
- `openaiQuery()` — calls an OpenAI-compatible chat completions API via `openai`

Each provider handles structured output, timeout, error logging, and activity logging uniformly.

### Warm slots (SDK only)

The SDK provider uses warm subprocess slots for latency-sensitive features. A warm slot keeps a Claude Code subprocess alive across multiple requests via the MessageChannel pattern, eliminating cold-start latency.

There are two warm slots, both built by the shared engine in `warm-slot.ts` (`createWarmSlot`), which owns init and warmup, reuse, recycling, the circuit breaker (5 recycles in 5 seconds marks the slot as dead), re-init backoff, `slot-failure` alerts and shutdown. They differ only in their concurrency policy:

**1. Enrichment slot** (`enrichment-slot.ts`): FIFO queue — requests wait in order for the single subprocess. After `MAX_REUSES` (default 8) results, the slot recycles (closes old subprocess, starts a new one). Policy: `fifoQueuePolicy`.

**2. Quick Take slot** (`quick-take-slot.ts`): Latest-wins cancellation — only the most recent quick take matters, so new requests supersede in-flight ones. Lower max reuses (default 4) since quick takes are less frequent. Policy: `latestWinsPolicy`.

No caller may wait on a slot forever (the state-transition table is at the top of `warm-slot.ts`). A query that times out means the subprocess has hung, so the slot kills it and recycles rather than staying busy; a warmup that fails, including the one a recycle starts, marks the slot dead and rejects every queued caller. Each rejected enrichment counts as a normal failed attempt, so the queue keeps moving and the task ends `ai-failed` after two.

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

After a successful model run on a task added in the last 15 minutes, either path sends one quiet "AI finished" push with the cleaned title and what the AI filled in (the Just added card, on the lock screen). Never on failure. See `docs/NOTIFICATIONS.md` § "AI finished" notification.

### Shared project support

Enrichment queries both owned and shared projects when building the project list for AI. This allows the model to route tasks to shared projects. The project list format indicates which projects are shared:

```
- Inbox (id: 1)
- Shopping List (id: 5, shared)
- Oak Rental (id: 7) — Duplex at 412 Oak St, tenants Priya and Dev
```

A project with a `description` (what belongs there, up to 280 characters) gets it after " — ", on one line; with none, the field is left out. When any description is listed, the heading says what they are for (they only settle which project the words mean). Enrichment has read them since 2026-10-16; Process read them first.

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
├── warm-slot.ts        — Warm slot engine (createWarmSlot: lifecycle + FIFO / latest-wins policies)
├── enrichment-slot.ts  — Warm SDK slot for enrichment (FIFO queue, JSON schema)
├── enrichment-api.ts   — API-mode enrichment query (Anthropic/OpenAI, no warm slot)
├── enrichment.ts       — Task enrichment pipeline (on-demand + safety-net cron)
├── quick-take.ts       — Quick Take prompt building and generation
├── quick-take-slot.ts  — Warm SDK slot for Quick Take (latest-wins cancellation)
├── whats-next.ts       — What's Next recommendations (surfaces overlooked tasks)
├── insights.ts         — AI Insights batch scoring, signals, and session management
├── process.ts          — Process button: project recommendations and duplicate groups
├── format.ts           — Shared task formatting for AI prompts
├── user-context.ts     — User AI context and per-feature mode preferences
├── task-summaries.ts   — Compact task data builder for AI prompts
└── purge.ts            — Activity log data retention
```

### `types.ts`

- `EnrichmentResultSchema` — Zod schema for task enrichment output (reasoning, title, due_at — the target, deadline_at, horizon, priority, labels, project_name, rrule, auto_snooze_minutes, recurrence_mode, notes). `reasoning` is first on purpose (2026-10-20): the model writes the fields in schema order, so it works each one out before committing to it — with it last, "at noon" said at 10:58 AM came back tomorrow noon while the reasoning said today. `deadline_at` and `horizon` default to null so a text-fallback answer without them still parses
- `TaskSummary` — also carries optional `deadline_at` and `horizon` (2026-10-10)
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
- `alignTaskModelDates()` — rolls a long-past deadline or recurring first date forward a year; drops a target that falls after the deadline
- `sanitizeTaskModelFields()` — post-parse guard for `deadline_at` (dropped without a cutoff word in the input) and `horizon` (dropped without a pace word); both dropped on a recurring result
- `sanitizeReminderEnrichment()` — clears every task-shaped field on a reminder, `deadline_at` and `horizon` included
- `applyQuotaEnrichment()` — a quota's write: the plan as an edit through `collectFieldChanges` + `applyFieldChanges` (2026-10-24)
- `describeEnrichment(taskId, userId, fields)` — the toast's words for what the AI set; the sync event and `POST /api/tasks` `wait` both use it

### `quota-enrichment.ts`

- `postProcessQuotaEnrichment(parsed, text, slots)` — a quota answer → the stored plan (period rule, target, reminder period, one explicit label); production and the quality harness both call it
- `withoutQuotaFields()` — nulls the `quota_*` fields on a task or reminder answer
- `QUOTA_PROVISIONAL_RULE` — `FREQ=WEEKLY`, the period a quota from words starts with
- `quotaCadenceWords()` / `quotaPromptWords()` — "3× a week", "Reminds at Midday" for the toast and the push

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
- Task selection (`selectRelevantTasks`): includes tasks targeted within 7 days, overdue, or with no target — and any task whose `deadline_at` is within 7 days or passed, however far out its target is

### `insights.ts`

- `startInsightsGeneration(userId, timezone, tasks)` — fire-and-forget background generation with session tracking
- `generateInsightsForUser(userId, timezone, tasks)` — blocking generation (used by nightly cron)
- `getInsightsSessionStatus()` / `getInsightsResults()` / `hasInsightsResults()` — retrieval and polling
- `sanitizeSignals()` — defense-in-depth enforcement of signal rules (P4 score ceiling, `actSoonAllowed()` for act_soon, stale requires 21+ days old)
- `actSoonAllowed()` — a stored `deadline_at` within 7 days (or passed) allows act_soon at any priority, and one further out forbids it at any priority; a task with no deadline falls back to P3+ (deadlines written in notes)
- `INSIGHTS_SIGNALS` / `SIGNAL_MAP` — signal vocabulary with display properties (label, color, icon)
- Chunking by output budget (`insightsTasksPerCall()`): tasks per call = the call's output cap (`output-limits.ts`, thinking budget deducted) × 0.6 ÷ the measured cost of a task (60 tokens with an explicit thinking budget, 240 for a model that may think unasked, like Haiku 5.5), between 10 and 500 — 20 a call on an 8192-cap API model, 220 for Opus on the SDK. A list that fits goes in one call; a larger one is shuffled into equal chunks, each with a calibration summary. A chunk cut off at the output cap (`truncated`) or that does not parse is retried once as two halves
- Later option, not done: turn off the thinking Haiku 5.5 does unasked, for Insights only (`thinking: { type: 'disabled' }`). Measured 2026-10-21 it drops a task to ~48.5 output tokens, so ~98 tasks a call on an 8192 cap instead of 20 (2 calls for 196 tasks instead of 10). It changes how the model scores, so it needs its own Layer 2 pass against the current output before it ships
- Session status: `completed` counts the tasks actually scored; none scored → `failed` with an `error` (earlier results kept); some → `complete` with an `error` naming how many were not (the AI panel's Insights section and the toast after a run show it as a quiet muted line, "N tasks couldn't be scored"). A running session gets a `heartbeat_at` after every chunk and is judged stale (auto-failed) after 20 minutes without one, so a long chunked run stays alive while it progresses

### `message-channel.ts`

Generic async iterable that buffers messages and yields them when the SDK calls `next()`. Used by both warm slots to reuse a single subprocess across multiple queries.

### `slot-shared.ts`

Shared utilities for warm slot infrastructure: `SlotState` type, `BaseSlotStats` interface, warmup validation, env var parsing, circuit breaker check. Used by `warm-slot.ts` and both slots.

### `warm-slot.ts`

`createWarmSlot(config, policy)` — the warm slot engine both slots are built on: subprocess init and warmup, the background stream consumer, reuse and recycling, circuit breaker, re-init backoff, `slot-failure` alerts, stats, shutdown and a test reset. State lives on globalThis under the slot's own key (`__enrichmentSlotState`, `__quickTakeSlotState`). The two concurrency policies are `fifoQueuePolicy` (enrichment) and `latestWinsPolicy` (quick take).

### `queue.ts`

- `acquireSlot()` / `releaseSlot()` — FIFO semaphore
- `withSlot(fn)` — convenience wrapper with automatic release
- `getQueueStats()` — returns active/waiting/max for monitoring

### `format.ts`

- `formatLocalDate()` — ISO UTC to human-readable local time
- `formatAge()` — pre-computed age string (prevents AI hallucination)
- `formatTaskLine()` — consistent one-line task format for AI prompts: `target:` (the old due date; `none` when unset), `deadline:` and `horizon:` only when set, and `(first target: …)` for P3+ tasks whose target moved
- `getScheduleBlock()` — user's wake/sleep schedule for prompts

### `process.ts`

- `recommendProjects(userId, taskIds)` — the project each task probably belongs in, or null; reads project `description`s and the user's `ai_context`. Never writes
- `findDuplicates(userId)` — groups of open one-off tasks that look like the same work. Never writes
- `buildRecommendProjectsPrompt()` / `buildDuplicatesPrompt()` — pure prompt builders shared with the quality harness
- `sanitizeRecommendations()` / `sanitizeDuplicateGroups()` — drop anything the model was not given (unknown task ids, a project the user doesn't have, groups under two tasks, a task in two groups)
- Returns `{ status: 'ok' | 'disabled' | 'failed' }`; uses the `process` feature's mode (`ai_process_mode`), model and timeout

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

| Failure                        | What happens                                                                                                        | User sees                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| No provider available          | `isAIEnabled()` set to false, AI disabled                                                                           | Nothing — app works normally      |
| API key invalid                | Provider returns 401, logged as error                                                                               | Warning icon, raw text preserved  |
| Provider request fails         | `ai-to-process` label stays, retried next cycle                                                                     | Spinner continues                 |
| Provider hangs                 | Timeout fails the attempt (retry tracking incremented); a warm slot kills and replaces the hung subprocess          | Warning icon after 2nd failure    |
| Model returns invalid output   | `ai-failed` label applied after 2 attempts                                                                          | Warning icon, raw text preserved  |
| Model extracts wrong fields    | Changes applied and logged in undo                                                                                  | User can Cmd+Z to revert          |
| Server restarts mid-enrichment | In-memory processing set resets, tasks retried                                                                      | Re-processed automatically        |
| Rapid consecutive failures     | Circuit breaker pauses queue for 5 minutes                                                                          | Pending tasks wait                |
| Warm slot dies                 | Marked dead; queued enrichments fail as attempts (retried, then `ai-failed`); Quick Take falls back to a cold query | Enrichment retried next cycle     |
| Semaphore full                 | Request queued FIFO, times out after 30 seconds                                                                     | Loading indicator, eventual error |
| What's Next cache hit          | Cached result returned immediately                                                                                  | Instant response                  |
| Insights session crash         | Stale session auto-failed after 20 minutes                                                                          | User can re-trigger               |

**No auto-retry on failure.** Failed tasks stay failed (after 2 attempts) to prevent cost runaway.

---

## Feature Catalog

The Quick Take, What's Next and Insights rows are SHELVED (2026-10-22) — see the note at the top.

| Feature     | Description                                          | Default model | Trigger                                 | Cache                    |
| ----------- | ---------------------------------------------------- | ------------- | --------------------------------------- | ------------------------ |
| Enrichment  | Parse natural language into structured task          | Haiku         | Task creation (async)                   | —                        |
| Quick Take  | One-liner commentary on task creation                | Sonnet        | Task creation (async, after enrichment) | —                        |
| What's Next | Surface easily overlooked tasks                      | Haiku         | 3 AM cron + on-demand                   | ai_activity_log (daily)  |
| Insights    | Batch task scoring, commentary, and signal detection | Opus          | On-demand + nightly cron                | ai_insights_results (DB) |
| Process     | Project recommendations and duplicate groups         | Opus          | On-demand (Process button)              | —                        |

### Enrichment

Parses natural language task input into structured fields: clean title, due date, priority, labels, project, recurrence rule, auto-snooze, recurrence mode, and notes. Runs asynchronously after task creation. Uses the warm enrichment slot (SDK) or a direct API call (Anthropic/OpenAI).

**Project assignment** has two triggers (Trent, 2026-09-28): an explicit instruction ("add it to Work", "put it in shopping"), or a **name match** — the task text contains a project's full name as a phrase, case-insensitive, used as that name ("test task for job search" → Job Search, "print the expense report for work" → Work). There is still no inference from topic ("apply to Acme" does not go to Job Search). The name-match guard: whole words only ("homework"/"workout" do not match Work), not a verb ("work out"), not a schedule cue or direction ("after work", "on the way home"), never Inbox; two matches → the longer name wins, otherwise null. **Project descriptions** (2026-10-16) are listed with the projects but are never a third trigger: a description only settles which project the words mean when they could mean several ("add it to the rental project" with Oak Rental and Pine Rental → the one whose description names the tenant), and never pulls a task away from a project its words name. `filterProjectMatch()` still drops any pick whose name is not in the words. The server resolves `project_name` by exact name (`COLLATE NOCASE`) and `sanitizeReminderEnrichment` nulls it for reminders, which never belong to a project. Like labels, projects have a post-parse guard: `filterProjectMatch()` keeps the model's `project_name` only if a word of the project's name (3+ letters) appears in the input as a whole word. It admits explicit partial names ("put it in shopping" → Shopping List) and rejects every topic-only pick — the model still did those sometimes after name matches were allowed, because it then emitted `project_name` before its reasoning (reasoning has come first since 2026-10-20; the guard stays). Whether a present word is used _as_ the name ("after work", "work out") stays the prompt's job. Known cost: an assignment by synonym ("put this in groceries" for Shopping List) is dropped. The quality harness applies the same guard and logs when it changes the model's answer. **A name match never moves a task out of a project the user chose** (Trent, 2026-09-28; `allowProjectMove()`): a task in the Inbox moves on either trigger, but a task already in another project moves only on an explicit instruction. The two are told apart by the prompt's contract — an explicit instruction is removed from the title, a name match stays in it — so outside the Inbox the move is kept only if none of the chosen project's name words (same whole-word test) remain in the enriched title. Quality scenarios all start in the Inbox, so the harness does not need this rule.

Extracted labels pass through `filterExplicitLabels()` — a post-parse guard that strips AI-inferred labels unless the user's input contains explicit label-intent language (e.g., "label it", "tag it", "mark it as").

**Target, deadline and horizon** (task model, 2026-10-10; docs/TASK-MODEL.md § Deadline, target, horizon). The single due date became three fields, and enrichment fills each only from what the user said:

- `due_at` is the **target** — the day and time the user said to do it ("Friday at 2pm", "remind me Thursday at 9", "tomorrow morning"). A day with no time ("tomorrow", "do it Saturday", "today") comes back as the date alone and goes **on deck** for that day instead (`on_deck_day`, no target; 2026-10-20, see **On deck** below). Since 2026-10-12 a target makes a task **quiet until its date** (only Upcoming heads-ups before it; docs/TASK-MODEL.md § Upcoming), so a wrong AI target buries the task. The prompt says so and sets `due_at` only from a stated day or time — never inferred from topic, a deadline, urgency, priority or a pace word; when unsure, null.
- `deadline_at` is the **real cutoff**, set ONLY from stated cutoff wording: "by Friday", "before the 17th", "due to the client Monday 10am", "expires Oct 13", "the deadline is Feb 28", "closes at 9pm". A cutoff day with no time is the end of that day (23:59 local). A cutoff-only date leaves `due_at` null (the app nags from the deadline on its own); "Cancel M365 by Oct 17, do it Wednesday" sets both. Never inferred — not from urgency, topic, or a target date. An AI-guessed deadline is worse than an AI-guessed date because it caps snoozing.
- `horizon` is the **pace**, set ONLY from explicit pace wording: "today or tomorrow" / "in the next few days" → days, "this week" → weeks, "sometime this month" → months, "eventually" / "someday" → eventually. Otherwise null (unset, read as weeks). Never from topic or size (Trent's 09-28 "no inference from topic" ruling), never from priority words ("no rush" is still priority 1), never from a named day. "By the end of the month" is a deadline, not a horizon. Setting a horizon also stamps `horizon_set_at`.
- Recurring tasks, reminders and quotas get neither field; a cutoff on a recurring task stays its time in `due_at` ("every Friday by 5pm").

**Quota enrichment** (2026-10-24; plan `.tmp/plan-quota-enrichment-1022.md`, approved 10-22). A quota can be made from free text: `POST /api/tasks {"title": "lift 3x a week, remind me at lunch", "is_tracked": true}` (docs/AUTOMATION.md § Adding a quota). **The caller declares the kind** — the AI never classifies a task as a quota: the same words ("twice a week") are a repeating task, a reminder or a quota depending on what the user meant, and a task misread as a quota goes quiet. `createTask` stores a provisional quota at once (`FREQ=WEEKLY`, target 1, `ai-to-process`) — only when enrichment will run (AI on, the user's enrichment mode not Off, title-only); otherwise the usual "a quota needs a period" 400, saying to send `rrule` or turn AI on. It is part of the **enrichment** feature: the same mode, model, timeout and warm slot, so it is never shelved. The pipeline routes a quota row (`is_tracked`/`progress_target` on the claim) to its own user prompt, `buildQuotaEnrichmentUserPrompt`, beside the reminder's and for the same reason — the warm slot pins one system prompt and one schema, so the user turn counteracts the task priming (above all "twice a week → BYDAY=TU,TH"). The count and period travel in five `quota_*` schema fields (appended last; null for every task and reminder, nulled by `withoutQuotaFields`), because a bare `FREQ=WEEKLY` is not a valid task rule. Rules the prompt states: the target only from occurrence words ("twice", "3x", "a couple"), "every other day" / "once a fortnight" / "quarterly" as intervals, named weekdays as a weekly count with the days in notes, and **units** (Trent, 10-22): a quota counts times, so a measured amount of one doing stays in the title ("100 pushups a day" → "100 pushups", 1 a day; "read 20 min every day" → "Read 20 min") while separate occasions are the target ("8 glasses of water a day" → 8). The reminder period only when the user said when ("at lunch" → the period noon falls in; nothing said → null, the user's default), "don't remind me" → prompt off; labels explicit-only and at most one; no project. `postProcessQuotaEnrichment` makes the stored plan: the period via `quotaRule` (an INTERVAL past `QUOTA_INTERVAL_MAX` is dropped, not clamped; a task-style rule the model wrote anyway gives its FREQ and its day count as a fallback), the slot by label or nearest start. `applyQuotaEnrichment` writes it through `collectFieldChanges` + `applyFieldChanges` (not raw SQL like the task path), after `settleQuotaPeriod`, so every quota invariant, the period re-anchor with its count carry, and the prompt-slot ownership check apply; dropped when the user edited the row meanwhile or it is no longer a quota; no undo entry on the initial enrichment, one on a re-enrichment. The toast and the "AI finished" push say "3× a week · Reminds at Midday" (the push "Added to Quotas · …", with no APNs buttons). `POST /api/tasks` `wait: true` holds the response up to 20 s and reports `data.ai` (`done` / `pending` / `failed` / `skipped`, with the toast's description). Future (not built): one prompt that classifies task / reminder / quota itself (`kind: 'auto'`), with "task" when unsure.

`sanitizeTaskModelFields()` backs the prompt in code: it drops a deadline when the input has no cutoff word, a horizon when it has no pace word, and both on a recurring result. `alignTaskModelDates()` then fixes two date slips the model still made in testing: a deadline (or a recurring task's first date) more than 7 days in the past is a wrong year and moves forward a year, and a target that falls after the deadline is dropped. The guard cannot tell whether a present cue word is used as one ("drop it off before work" is a target) — that stays the prompt's job. Like a target, both fields are set-only: a null from the model never clears what the task already has. The enrichment toast names them ("Deadline Fri 11:59 PM", "Within weeks").

### Quick Take

Generates a snappy one-liner after task quick-add, showing awareness of the user's existing tasks. Cross-references when relevant ("3 Acme tasks this week — this makes it a theme") or gives a brief observation.

The prompt is split into a static system prompt (loaded once at slot init) and a dynamic user prompt (pushed per request). Statistics are precomputed in code (due today, due this week, by project, by label, busiest day) so the model reads numbers rather than scanning the task list itself.

### What's Next

Helps the user decide what to focus on — surfacing tasks that deserve attention, are easy to forget, or represent opportunities for progress. Filters to tasks targeted within 7 days, overdue, or with no target, plus any task whose deadline is within 7 days. Results cached in `ai_activity_log` for same-day retrieval.

**Target vs deadline in What's Next and Insights** (2026-10-10). The prompts used to read a P3/P4 due date as a deadline. The deadline is its own field now: task lines show `target:` (soft — being past it is routine for P0-3), `deadline:` and `horizon:`, and the shared behavioral model says a deadline is the real cutoff at any priority. Tasks with no `deadline:` field may still state one in their notes (every task created before the field existed), so a P3-4 deadline in the notes is still honored.

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

Code-enforced signal rules (defense-in-depth): P4 scores capped at 25; `act_soon` needs a real cutoff within 7 days — a stored `deadline_at` within 7 days or passed (any priority; a stored deadline further out forbids it at any priority), or, with no stored deadline, P3+ (a deadline in the notes); `stale` requires 21+ days old. Lists larger than one call's output budget (20 tasks on an 8192-cap API model) are shuffled and split into equal chunks, each with a calibration summary of the full list. Extended thinking enabled for Opus models.

### Process

The AI half of the Process button (spec §5): two read-only endpoints the Process modal calls. Both only **recommend** — nothing is written; the user decides.

- `POST /api/process/recommend-projects` — body `{ ids }` (1–100 task ids) → `{ recommendations: [{ task_id, project_id | null, reason }] }`. Topic-based suggestion is allowed here, unlike in enrichment, because the user picks: the modal shows every project in a fixed order with the recommendation highlighted. The prompt gives each project's `description` (what belongs there; `projects.description`) and the user's global `ai_context`. Candidates are the user's own and shared projects minus the Inbox; a recommended id outside that set is dropped, so the task simply has no recommendation.
- `GET /api/process/duplicates` → `{ groups: [{ task_ids, reason }] }` — possible duplicates among the newest 600 open one-off tasks (no recurring tasks, reminders or quotas). Conservative by design; ids not in the candidate list are dropped, a task appears in at most one group, and groups under two tasks are discarded.

AI disabled (server-wide, or the user's Process mode off) returns an empty list with 200 — never an error. A failed model call returns 503.

**Its own feature (2026-10-22).** Process is the `process` AI feature: the user's `ai_process_mode` (`off` / `sdk` / `api`, the Process row in Settings → AI, `PATCH /api/user/preferences`), and its own model config. It is **not shelved** — nothing under `OPENTASK_AI_UNSHELVE` gates it, and its Settings row and AI Status entry show either way. Until that day it read the Insights mode, model and timeout, so the split keeps everyone where they were:

- `ai_process_mode` was backfilled once from each user's `ai_insights_mode` when the column was added (`runMigrations()`); afterwards the two are independent.
- Every Process env var falls back to its Insights twin when unset (`FEATURE_FALLBACK` in `models.ts`): `OPENTASK_AI_PROCESS_MODEL` → `OPENTASK_AI_INSIGHTS_MODEL`, `OPENTASK_AI_PROCESS_SDK_MODEL` → `OPENTASK_AI_INSIGHTS_SDK_MODEL` → `OPENTASK_AI_SDK_MODEL`, and `OPENTASK_AI_PROCESS_PROVIDER` / `_API_KEY` / `_BASE_URL` → the `INSIGHTS` ones → the global provider.
- There is no per-user Process timeout: it uses the built-in default (180 s API, 300 s SDK — Insights' defaults). A user's `ai_insights_timeout_ms` no longer applies to it.

AI Status lists Process among the features, and its activity filter has a Process chip that matches both logged actions (`process_projects`, `process_duplicates`).

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

### Per-feature models

| Env var                        | SDK/Anthropic default | Description               |
| ------------------------------ | --------------------- | ------------------------- |
| `OPENTASK_AI_ENRICHMENT_MODEL` | `haiku`               | Model for task enrichment |
| `OPENTASK_AI_QUICKTAKE_MODEL`  | `sonnet`              | Model for Quick Take      |
| `OPENTASK_AI_WHATS_NEXT_MODEL` | `haiku`               | Model for What's Next     |
| `OPENTASK_AI_INSIGHTS_MODEL`   | `claude-opus-4-6`     | Model for Insights        |
| `OPENTASK_AI_PROCESS_MODEL`    | (the Insights model)  | Model for Process         |

Short names (`haiku`, `sonnet`, `opus`) are mapped to full Anthropic model IDs automatically. OpenAI model strings pass through as-is.

Each feature also has an SDK-mode model (`OPENTASK_AI_<FEATURE>_SDK_MODEL`, falling back to `OPENTASK_AI_SDK_MODEL`, then `sonnet`) and optional per-feature provider routing (`OPENTASK_AI_<FEATURE>_PROVIDER`, `_API_KEY`, `_BASE_URL`); `<FEATURE>` is `ENRICHMENT`, `QUICKTAKE`, `WHATS_NEXT`, `INSIGHTS` or `PROCESS`. Every `PROCESS` variable falls back to its `INSIGHTS` twin when unset (see [Process](#process)).

### Which Claude Code CLI runs

`src/core/ai/cli-path.ts` picks the CLI every SDK subprocess spawns (the cold `sdkQuery()` path and both warm slots), once per process:

1. `OPENTASK_AI_CLI_PATH`, when set. PATH is not searched behind it, so a deliberately dead path stays dead (the screenshot harness relies on that).
2. Otherwise the first `claude` on `PATH` (searched directly, no shell).

Its version comes from `<path> --version` and must be **2.1.101 or newer**. At first resolution (at boot when the default provider is `sdk`, otherwise on the first SDK call) the server logs `[ai] Claude CLI: <path> v<version> (env|path)`. If no CLI is found, or it is older than the floor, or its version can't be read, the server logs an error and every SDK call throws `ClaudeCliError` ("Claude Code CLI not found: install Claude Code … or set OPENTASK_AI_PROVIDER=anthropic (or openai) …"); the feature fails visibly (activity log, error notification, a dead warm slot).

Provider detection checks the same thing: the SDK provider counts as available only when the Agent SDK imports **and** a usable CLI resolves (a `claude --version` probe, no session). On a box without one (Docker, an API-only install, a too-old CLI) `initAI()` warns once (`SDK provider unavailable: …`), falls back to a configured API provider (or disables AI when there is none), and no warm slot starts. A request that still asks for SDK mode (a per-user `sdk` setting) gets the `ClaudeCliError` above.

**Why there is no fallback to the SDK's bundled CLI.** `@anthropic-ai/claude-agent-sdk` bundles its own Claude Code (0.2.37 bundled 2.1.37; from 0.3 it comes as a per-platform optional package) and runs it whenever it isn't given a path. OpenTask spawns the CLI with no settings (`settingSources: []`), and CLIs before 2.1.101 then run their background cleanup without the user's settings: they ignore `cleanupPeriodDays` and delete every `~/.claude/projects` transcript older than 30 days (fixed upstream in 2.1.101). On a dev machine, an eval run or a cloud box, an AI call would quietly wipe a month of that machine's Claude Code history. So the SDK is always handed an installed CLI, and an old one is refused rather than run. The API providers (`anthropic`, `openai`) never resolve the CLI.

**The CLI runs isolated from settings files.** Every SDK query and warm slot passes `settingSources: []` (`src/core/ai/sdk-options.ts`), so the subprocess reads no `~/.claude` or project `settings.json`: no hooks, plugins, MCP servers or permission rules, and no `CLAUDE.md` in the model's context. Agent SDK 0.2.x did this by default; from 0.3 an omitted `settingSources` makes the CLI load user, project and local settings, so it is passed explicitly. A thinking budget (What's Next and Insights on Opus) goes as `thinking: { type: 'enabled', budgetTokens }`, which the CLI receives as `--max-thinking-tokens`, the same flag the deprecated `maxThinkingTokens` option produced in 0.2.x.

### SDK-specific settings

These only apply when using the Claude Agent SDK (subprocess) provider:

| Env var                            | Default | Description                                              |
| ---------------------------------- | ------- | -------------------------------------------------------- |
| `OPENTASK_AI_MAX_REUSES`           | `8`     | Max queries per warm enrichment subprocess               |
| `OPENTASK_AI_QUICKTAKE_MAX_REUSES` | `4`     | Max queries per warm quick take subprocess               |
| `OPENTASK_AI_QUICKTAKE_TIMEOUT_MS` | `40000` | Timeout for quick take queries in milliseconds           |
| `OPENTASK_AI_CLI_PATH`             | (PATH)  | Claude Code CLI (≥ 2.1.101); default: `claude` on `PATH` |
| `OPENTASK_AI_MAX_CONCURRENT`       | `4`     | Maximum concurrent SDK subprocesses (per-query)          |
| `OPENTASK_AI_QUEUE_TIMEOUT_MS`     | `30000` | Maximum wait time for semaphore slot                     |

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

# OpenAI (per-feature models required)
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=sk-...
OPENTASK_AI_ENRICHMENT_MODEL=gpt-4.1-mini
OPENTASK_AI_QUICKTAKE_MODEL=gpt-4.1-mini
OPENTASK_AI_WHATS_NEXT_MODEL=gpt-4.1-mini
OPENTASK_AI_INSIGHTS_MODEL=gpt-4.1

# xAI (Grok)
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=xai-...
OPENAI_BASE_URL=https://api.x.ai/v1
OPENTASK_AI_ENRICHMENT_MODEL=grok-4-1-fast
OPENTASK_AI_QUICKTAKE_MODEL=grok-4-1-fast
OPENTASK_AI_WHATS_NEXT_MODEL=grok-4-1-fast
OPENTASK_AI_INSIGHTS_MODEL=grok-4-1-fast

# Ollama (local, free)
OPENTASK_AI_ENABLED=true
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENTASK_AI_ENRICHMENT_MODEL=llama3.1
OPENTASK_AI_QUICKTAKE_MODEL=llama3.1
OPENTASK_AI_WHATS_NEXT_MODEL=llama3.1
OPENTASK_AI_INSIGHTS_MODEL=llama3.1

# Claude Code SDK (no API key needed — uses your Claude Code auth)
OPENTASK_AI_ENABLED=true
```

---

## Activity Logging

Every AI operation is logged in the `ai_activity_log` table:

| Column        | Type    | Description                                                                                                                      |
| ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | INTEGER | Primary key                                                                                                                      |
| `user_id`     | INTEGER | Who owns the task                                                                                                                |
| `task_id`     | INTEGER | Which task (nullable for non-task operations)                                                                                    |
| `action`      | TEXT    | Operation type: `'enrich'`, `'whats_next'`, `'insights'`, `'quick_take'`, `'process_projects'`, `'process_duplicates'`, `'test'` |
| `status`      | TEXT    | `'success'`, `'error'`, `'skipped'`                                                                                              |
| `input`       | TEXT    | Raw input (e.g., original task text)                                                                                             |
| `output`      | TEXT    | JSON result from AI                                                                                                              |
| `model`       | TEXT    | Which model was used                                                                                                             |
| `duration_ms` | INTEGER | How long the query took                                                                                                          |
| `error`       | TEXT    | Error message if failed                                                                                                          |
| `provider`    | TEXT    | Which provider was used: `'sdk'`, `'anthropic'`, `'openai'`                                                                      |
| `created_at`  | TEXT    | ISO 8601 timestamp                                                                                                               |

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

| File                                 | Category                                                    | Count |
| ------------------------------------ | ----------------------------------------------------------- | ----- |
| `enrichment-core.ts`                 | Core enrichment (title, date, priority, etc.)               | 32    |
| `enrichment-priority.ts`             | Priority inference                                          | 13    |
| `enrichment-recurrence.ts`           | Expanded recurrence patterns                                | 15    |
| `enrichment-edge.ts`                 | Edge cases                                                  | 11    |
| `enrichment-labels.ts`               | Explicit-only label extraction                              | 10    |
| `enrichment-dictation.ts`            | Dictation realism and typo tolerance                        | 10    |
| `enrichment-context.ts`              | User context resolution                                     | 8     |
| `enrichment-projects.ts`             | Project assignment — explicit and name match                | 10    |
| `enrichment-voice.ts`                | Voice preservation                                          | 8     |
| `enrichment-reminders.ts`            | Reminder enrichment — cadence and time slots (§6)           | 11    |
| `enrichment-quotas.ts`               | Quota enrichment — count, period, units, reminder period    | 20    |
| `enrichment-task-model.ts`           | Target, deadline and horizon (2026-10-10)                   | 31    |
| `enrichment-soon.ts`                 | Soon today: "now", "in an hour", hour ranges                | 13    |
| `enrichment-project-descriptions.ts` | Project descriptions settle which project the words mean    | 6     |
| `enrichment-same-day.ts`             | Same day: "tomorrow" dated today, a passed time, "now that" | 6     |
| `enrichment-repeat-titles.ts`        | Repeat words leave the title; a repeat made after its time  | 7     |
| `enrichment-late-today.ts`           | "Today" at 10:57 PM stays on today's local date             | 4     |
| `enrichment-on-deck.ts`              | On deck: a day with no time decks; times, parts of day stay | 30    |
| `task-model-review.ts`               | Deadline field in Insights and What's Next                  | 2     |
| `process.ts`                         | Process: project recommendations and duplicates             | 4     |
| `quick-take.ts`                      | Quick Take                                                  | 12    |
| `insights.ts`                        | AI Insights scoring and signals                             | 11    |
| `whats-next.ts`                      | What's Next recommendations                                 | 8     |
| `insights-large.ts`                  | Large-scale insights (50-600 tasks, production)             | 3     |
| `helpers/generate-tasks.ts`          | Realistic task list generator (used by insights-large)      | —     |
| `index.ts`                           | Barrel export                                               | —     |

**Total: 292 scenarios** (217 enrichment + 11 enrichment*reminder + 20 enrichment_quota + 13 quick_take + 17 insights + 10 whats_next + 2 process_projects + 2 process_duplicates; counted 2026-10-24 by `grep -ho "feature: '[a-z*]_'" tests/quality/scenarios/_.ts | sort | uniq -c` — the per-file counts above are older)

Scenarios that need a value the run date decides (a deadline "7 days from now") compute it at load time; `must_include` accepts `~date:YYYY-MM-DD` (a local datetime on that day, any time) and `~notnull`. An enrichment scenario may pin `now` (a local datetime in its timezone): the prompt, the post-processes and the time matchers then all read that minute — `~soon` ("now": 15 minutes out, rounded up to the quarter hour), `~in-hours:N` and `~hours-range:LO-HI` (a quarter hour inside the range). Process scenarios use `process_expectations` (required project per task, groups that must appear, pairs that must not be grouped).

**Soon today** (2026-10-16): "now" / "right now" / "immediately" is about 15 minutes out, rounded UP to the next quarter hour; "in an hour" / "in N hours" is now + N hours, rounded up to the quarter hour; a range ("in an hour or two", "in 2 or 3 hours") is a whole hour inside it, picked by the model. The model's arithmetic was unreliable in the quality runs (2:07 → 2:15, 11:52 PM → midnight, "in 2 or 3 hours" at 2:10 → 4:00), so `resolveSoonTarget` in `enrichment.ts` recomputes "now" and "in N hours", and replaces a range pick that is not a quarter hour inside the range with the first whole hour in it — only when the model set a target and the cue is the only time or day in the words.

**Repeat words in titles** (2026-10-16): the prompt's title rule says repeat wording leaves the title once it is in `rrule` ("Water the ferns every other day" → "Water the ferns"), and a repeat word that names something stays ("Weekly standup"). The backstop is `stripRepeatPhrase` (`src/core/ai/repeat-title.ts`): a TRAILING phrase, or a LEADING one that reads as a time clause ("Every Monday, …"), is removed only when it says exactly what the parsed rule says, per a small table ("every other day" ↔ `FREQ=DAILY;INTERVAL=2`, "twice a week" ↔ weekly on two days, "every Monday" ↔ `WEEKLY;BYDAY=MO`, …); otherwise the title is untouched. It runs in `postProcessTaskEnrichment` (the date post-process, then the title), which production and the harness share. A new task's repeat whose first date the model put in the past (earlier today or any earlier day) starts at its next occurrence (`rollPassedRepeatStart`, the create path's `rollPassedFirstOccurrence`); only on the enrichment of a just-created task (`newTask`), never a re-enrichment of one that already has a date or rule.

**"Today" is today's local date** (2026-10-17): at 10:57 PM CDT the SDK put a "today" task on the next day, the UTC date. When the words say "today" or "tonight" and name no other day, a one-off target the model dated another day moves to today's local date (`resolveTodayLocalDate`): a clock time in the words stays that time today, as said; with none, the model's time today while it is still ahead, else the app's own placement of a bare "today" (`todayTarget`). Repeating tasks are left to the first-occurrence rules. It runs before the same-day rule, which never acts on a "today"/"tonight" text.

**Same-day fixes** (2026-10-16): a one-off target the model dated today moves to the same time tomorrow when the words say "tomorrow" (not inside a word like "Tomorrowland"), or when its time has already passed and the words name no clock time (`resolveSameDayPast`; "tonight", "today", "now" and "in N hours" keep it today). "now that …", "for now" and "by now" with no other time or day words, and a target in the "now" slots (the current quarter hour up to the soon slot), give no target (`dropNowPhraseTarget`). Both came from claude-haiku-5-5 on the demo: "call mom tomorrow evening" at 7:52 PM dated today 7 PM, and "now that the lease is signed call the landlord" at 7:38 PM given 7:45 PM.

**On deck** (2026-10-20, D3; docs/TASK-MODEL.md § On deck → Enrichment): a day with no time ("do it Saturday", "today", "tomorrow", a bare "this weekend") puts the task on deck for that day; a clock time or a part of day ("tomorrow morning", "tonight", "this afternoon") stays a target; a deadline plus a day keeps a picked target; "remind me <day>" and "nag me <day>" (2026-10-22) with no time are a target that day at the default time, never a deck. The prompt asks for the date alone; `resolveDeckDay` turns it into `on_deck_day` (the harness's output carries the field, and `~date:` works on it), with a code floor for the old default-time answer, A4 ("tomorrow" between midnight and the rollover is the calendar today, for a deck and for a timed target alike — `saidTomorrowBeforeRollover`, `resolveEarlyTomorrow`; the harness uses a default user's 7:00 rollover) and the same day fixes the target rules make. What's Next, Insights and Quick Take read a deck as a plan (`on deck:` / `deck:` in the task lines).

**Past-date guard** (2026-10-16): a target or deadline dated before today (the user's local date) is dropped when the words could not state a past day (no "yesterday", "ago", "last", weekday, month, ordinal, numeric date or year): `dropUnstatedPastDates`. It caught grok-4-1-fast giving "now that the lease is signed call the landlord" a target a year in the past. A repeating task is left to its rule. The prompt's "Current local time" names the year (2026-10-16): without it grok dated nearly every target a year back, which this guard then had to erase. All the date post-processes run in one function, `postProcessTaskDates`, which production (SDK and API mode) and the quality harness both call.

Reminder scenarios are a separate feature, not a subset of enrichment: a
reminder has its own user prompt (`buildReminderEnrichmentUserPrompt`) built
around the user's time slots, and its result passes through
`sanitizeReminderEnrichment` before it is judged, so what a scenario asserts is
what the database would actually receive.

A reminder whose text states no time of day goes in the user's **default
reminder slot** (Settings → Reminder periods → Default reminder period; Trent,
2026-09-28). The prompt marks that slot `← default slot`, a scenario names it
with `defaultSlotLabel`, and the sanitizer falls back to it when the model's
rule carries no BYHOUR. Before that it was the slot current at enrichment time.

Quota scenarios (`enrichment_quota`, 2026-10-24) are a feature of their own too:
the quota user prompt (`buildQuotaEnrichmentUserPrompt`), then the same
`postProcessQuotaEnrichment` production runs, so the output is the stored plan —
`rrule` (the bare period rule, or null to keep the provisional one),
`progress_target`, `prompt_slot_label` (null = the user's default),
`prompt_enabled`, `labels`, `title`, `notes` — plus `model_answer`, the raw
answer, for the Layer 2 judge only. The harness logs when the answer carried a
task-style `rrule` (task priming) that the post-process had to fall back on.

Each scenario defines:

- `id` — unique identifier (e.g., `enrich-garbled-dictation`)
- `feature` — which AI feature (`enrichment`, `enrichment_reminder`, `enrichment_quota`, `whats_next`, `insights`, `quick_take`, `process_projects`, `process_duplicates`)
- `input` — feature-specific input data
- `requirements` — structural checks (`must_include`, `must_not_include`) and qualitative notes (`quality_notes`)

### How to adjust evaluation criteria

Edit `tests/quality/validator-prompt.md`. The rubric is organized by feature with specific criteria for each.

### Key files

| File                                | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `tests/quality/types.ts`            | Type definitions for scenarios, inputs, outputs    |
| `tests/quality/scenarios/`          | Test scenario definitions (143 scenarios)          |
| `tests/quality/ai-quality.test.ts`  | Layer 1 runner (vitest)                            |
| `tests/quality/validator-prompt.md` | Layer 2 judge rubric                               |
| `vitest.quality.config.ts`          | Separate vitest config (long timeouts, sequential) |

### Dump-prompts reference

The main `AGENTS.md` has a condensed AI quality testing section with pointers here. The subsections below provide the operational details.

`dump-prompts` is the only reliable way to see what the AI actually receives. Prompt source code is spread across `src/core/ai/prompts.ts`, `src/core/ai/quick-take.ts`, shared sections, and template literals — reading the source alone is not sufficient.

```bash
npm run dump-prompts                              # All prompts (templates only) → .tmp/prompts.txt
npm run dump-prompts -- --feature enrichment      # Just the enrichment prompt
npm run dump-prompts -- --feature enrichment_reminder  # The reminder variant (slots instead of workday times)
npm run dump-prompts -- --feature enrichment_quota     # The quota variant (count, period, reminder period)
npm run dump-prompts -- --feature insights         # Just the insights prompt
npm run dump-prompts -- --feature whats_next       # Just the what's next prompt
npm run dump-prompts -- --feature quick_take       # Just the quick take prompt (shows static system prompt and per-request dynamic slot separately)
npm run dump-prompts -- --scenario insights-medium-list  # Render with a test scenario's task data
npm run dump-prompts -- --list                     # List available scenarios
```

### Targeted re-runs

For iterating on failures without re-running the full suite. Layer 2 evaluation still applies — follow the same two-step process.

```bash
npm run test:quality:retry                                    # Re-run failures from last run
npm run test:quality:run -- enrich-simple-clean               # Run one scenario
npm run test:quality:run -- insights-boundary-stale insights-mixed-priorities  # Run multiple
```

### Workflow for modifying AI prompts

When modifying AI prompts or enrichment logic (task field inference in `src/core/ai/`):

1. **Dump the rendered prompt first** (`npm run dump-prompts -- --feature <feature>`) — read the full output in `.tmp/` and check for contradictions, stale rules, and redundancy. Do this before writing any code.
2. Make your changes
3. **Dump again after changes** — verify the rendered output matches your intent. The source code alone won't show you the complete picture.
4. Run both Layer 1 and Layer 2 on ALL scenarios (not just new ones) — see [Testing philosophy](#testing-philosophy) for why full coverage is required
5. Fix any regressions before proceeding
6. Add scenarios for new behavior — see [Scenario organization](#scenario-organization) for where they live
