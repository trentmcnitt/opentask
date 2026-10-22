/**
 * SHELVED (2026-10-22): Insights is shelved behind `OPENTASK_AI_UNSHELVE`
 * (src/core/ai/shelved.ts) until it is redesigned. The code stays in place,
 * dormant — do not "fix" or re-enable it without Trent.
 */
/**
 * AI Insights — batch task scoring, commentary, and signal detection
 *
 * Processes the user's entire task list in batches, scoring each task 0-100
 * based on how much it needs attention, adding one-line commentary, and
 * optionally tagging tasks with signals from a preset vocabulary.
 *
 * Results are cached in `ai_insights_results` for fast retrieval.
 * Generation progress is tracked in `ai_insights_sessions` for polling.
 */

import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { getDb, withTransaction } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { aiQuery } from './sdk'
import { parseAIResponse, extractJsonFromText } from './parse-helpers'
import { INSIGHTS_SYSTEM_PROMPT, INSIGHTS_REMINDERS } from './prompts'
import { formatTaskLine, getScheduleBlock } from './format'
import {
  InsightsBatchResultSchema,
  InsightsBatchEnvelopeSchema,
  InsightsBatchResponseSchema,
} from './types'
import type { InsightsItem, InsightsSignalKey, TaskSummary } from './types'
import { resolveFeatureAIConfig, type FeatureAIConfig } from './models'
import { resolveFeatureTimeout } from './user-context'
import { outputTokenBudget } from './output-limits'
import type { AIQueryResult } from './sdk'
import { log } from '@/lib/logger'

/**
 * Build the full Insights prompt from structured parameters.
 *
 * Shared by production and dump-prompts so the template is defined once.
 * Handles both single-call and chunked modes via the optional summaryBlock/contextBlock.
 */
export function buildInsightsFullPrompt(params: {
  currentTime: string
  totalTaskCount: number | string
  taskLines: string
  scheduleBlock?: string
  sourceBlock?: string
  userContext?: string | null
  summaryBlock?: string
  contextBlock?: string
}): string {
  const { currentTime, totalTaskCount, taskLines, userContext } = params
  const scheduleBlock = params.scheduleBlock ?? ''
  const sourceBlock = params.sourceBlock ?? ''
  const userContextBlock = userContext ? `\nUser context: ${userContext}\n` : ''
  const summaryBlock = params.summaryBlock ? `\n${params.summaryBlock}\n` : ''
  const contextBlock = params.contextBlock ?? `Total tasks: ${totalTaskCount}`

  return `${INSIGHTS_SYSTEM_PROMPT}
${summaryBlock}
## Context

Current time: ${currentTime}
${contextBlock}${scheduleBlock}${sourceBlock}${userContextBlock}
<tasks>
${taskLines}
</tasks>

${INSIGHTS_REMINDERS}
Current time: ${currentTime}
Score every task above. Return one entry per task in "tasks".`
}

// Wrapped in an envelope — structured-output schemas must have an object root.
// See InsightsBatchEnvelopeSchema for why.
const INSIGHTS_JSON_SCHEMA = z.toJSONSchema(InsightsBatchEnvelopeSchema) as Record<string, unknown>

// ---------------------------------------------------------------------------
// Signal vocabulary — display properties for UI rendering
// ---------------------------------------------------------------------------

export interface InsightsSignal {
  key: InsightsSignalKey
  label: string
  /** Tailwind color class prefix (e.g., 'indigo' → use bg-indigo-100, text-indigo-700) */
  color: string
  /** Lucide icon name */
  icon: string
  description: string
}

export const INSIGHTS_SIGNALS: InsightsSignal[] = [
  {
    key: 'review',
    label: 'Review',
    color: 'indigo',
    icon: 'Eye',
    description: 'Worth a closer look',
  },
  {
    key: 'stale',
    label: 'Stale',
    color: 'gray',
    icon: 'Clock',
    description: 'Sitting for weeks, might not be relevant',
  },
  {
    key: 'act_soon',
    label: 'Act Soon',
    color: 'amber',
    icon: 'AlertTriangle',
    description: 'Window closing, time-sensitive',
  },
  {
    key: 'quick_win',
    label: 'Quick Win',
    color: 'green',
    icon: 'Zap',
    description: 'Small task, easy to knock out',
  },
  {
    key: 'vague',
    label: 'Vague',
    color: 'blue',
    icon: 'HelpCircle',
    description: 'Unclear what this requires',
  },
  {
    key: 'misprioritized',
    label: 'Misprioritized',
    color: 'purple',
    icon: 'ArrowUpDown',
    description: 'Priority seems off for what this is',
  },
]

export const SIGNAL_MAP = new Map(INSIGHTS_SIGNALS.map((s) => [s.key, s]))

// ---------------------------------------------------------------------------
// Insights session types
// ---------------------------------------------------------------------------

export interface InsightsSession {
  id: string
  user_id: number
  /** complete may carry an `error` when some tasks could not be scored */
  status: 'running' | 'complete' | 'failed'
  total_tasks: number
  completed: number
  started_at: string
  finished_at: string | null
  error: string | null
  /** Set at start and after every chunk; staleness is judged from it */
  heartbeat_at: string | null
}

export interface InsightsResult {
  task_id: number
  score: number
  commentary: string
  signals: InsightsSignalKey[]
  generated_at: string
}

// ---------------------------------------------------------------------------
// Signal sanitization — defense-in-depth for prompt compliance
//
// The prompt instructs the AI to follow these rules, but Haiku sometimes
// ignores them when the task context feels urgent. We enforce them in code
// to guarantee no invalid signals reach the user.
// ---------------------------------------------------------------------------

const STALE_MIN_AGE_DAYS = 21
const ACT_SOON_MIN_PRIORITY = 3
/** A stored deadline this close (or already passed) earns act_soon at any priority. */
const ACT_SOON_DEADLINE_DAYS = 7
/** Score ceiling for P4 tasks — they're already visible, don't inflate. */
const P4_SCORE_CEILING = 25

/**
 * May this task carry act_soon ("real consequence within 7 days")?
 *
 * Task model (2026-10-10): the deadline is its own field now, and a near
 * deadline is act-soon at ANY priority — a P0 voucher that expires Friday is.
 * A stored deadline also rules: one more than 7 days out strips act_soon even
 * from a P4. A task with no stored deadline falls back to the old rule, P3+
 * only: that is where a deadline written in the notes lives (every task
 * created before the field existed), and the prompt still asks the model to
 * read those. Being past a target is never enough on its own.
 */
export function actSoonAllowed(task: TaskSummary, now: number = Date.now()): boolean {
  if (task.deadline_at) {
    const daysLeft = (Date.parse(task.deadline_at) - now) / (1000 * 60 * 60 * 24)
    return daysLeft <= ACT_SOON_DEADLINE_DAYS
  }
  return task.priority >= ACT_SOON_MIN_PRIORITY
}

/**
 * Enforce hard rules that the AI sometimes ignores:
 * - P4 score ceiling: clamp P4 task scores to 25 (user already sees these)
 * - act_soon needs a real cutoff within 7 days (`actSoonAllowed`)
 * - stale requires 21+ days old
 */
export function sanitizeSignals(items: InsightsItem[], taskMap: Map<number, TaskSummary>): void {
  for (const item of items) {
    const task = taskMap.get(item.task_id)
    if (!task) continue

    // P4 score clamping: these tasks are already demanding attention
    if (task.priority === 4 && item.score > P4_SCORE_CEILING) {
      log.debug(
        'ai',
        `Clamped P4 task ${item.task_id} score from ${item.score} to ${P4_SCORE_CEILING}`,
      )
      item.score = P4_SCORE_CEILING
    }

    if (item.signals.length === 0) continue

    const original = item.signals.length
    item.signals = item.signals.filter((signal) => {
      if (signal === 'act_soon' && !actSoonAllowed(task)) return false
      if (signal === 'stale') {
        const ageMs = Date.now() - new Date(task.created_at).getTime()
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
        if (ageDays < STALE_MIN_AGE_DAYS) return false
      }
      return true
    })

    if (item.signals.length < original) {
      log.debug(
        'ai',
        `Stripped invalid signals from task ${item.task_id} (had ${original}, kept ${item.signals.length})`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk processing
// ---------------------------------------------------------------------------

/**
 * How many tasks one Insights call may carry — sized by the call's output cap.
 *
 * Every task costs the call output tokens: its JSON entry (task_id, score, a
 * one-line commentary, signals) plus, on models that think on their own, the
 * thinking the model spends on it. A call whose answer outgrows the cap is cut
 * off mid-JSON and nothing in it can be stored — production lost a whole
 * 197-task run that way (2026-10-21: claude-haiku-5-5 on the API, `out 8192`).
 *
 * Measured 2026-10-21, claude-haiku-5-5 on the Anthropic API, the production
 * prompt and schema, tasks from the insights-large-realistic scenario
 * (n tasks → output tokens, of them thinking):
 *   15 → 2980 (2232) · 30 → 5279 · 45 → 7220 (4892) · 70 → 8192, cut off (7788)
 *   45 with thinking disabled → 2182 (0): 48.5 a task
 * So the JSON alone is ~50 tokens a task, and the thinking Haiku 5.5 does
 * unasked grows with the list: 160–200 tokens a task all told in one call.
 * Subset calls (shuffled chunks with the calibration summary) think more: the
 * 196-task quality scenario at 27 a call came back at 4151–7207 out per call,
 * 230 a task on average and 288 at worst (88% of the cap).
 *
 * - `INSIGHTS_TOKENS_PER_TASK_VISIBLE` (60): the call sets an explicit thinking
 *   budget (Opus), which `outputTokenBudget()` has already taken off the cap,
 *   so a task costs only its JSON (50, plus margin).
 * - `INSIGHTS_TOKENS_PER_TASK_ADAPTIVE` (240): no explicit budget — the model
 *   may think on its own, and that thinking comes out of the same cap (the
 *   chunked average above, rounded up; the worst chunk then fills ~70%).
 * - `INSIGHTS_OUTPUT_BUDGET_SHARE` (0.6): plan to fill at most 60% of the
 *   budget; commentary length and thinking both vary from run to run.
 * - `INSIGHTS_MAX_TASKS_PER_CALL` (500): the old single-call threshold, kept as
 *   the ceiling for very large caps (prompt size and attention, not output).
 *
 * Resulting chunk sizes: API Haiku (8192) → 20 · API Opus (16384 − 10000
 * thinking) → 63 · SDK Opus (32000 − 10000) → 220 · SDK without a thinking
 * budget (32000) → 80. A chunk that is cut off anyway is retried once as two
 * halves (`runInsightsChunk`).
 *
 * Lists larger than one call are shuffled and split into equal chunks, each
 * with a calibration summary of the whole list (see `processInsightsChunks`).
 */
export const INSIGHTS_TOKENS_PER_TASK_VISIBLE = 60
export const INSIGHTS_TOKENS_PER_TASK_ADAPTIVE = 240
export const INSIGHTS_OUTPUT_BUDGET_SHARE = 0.6
export const INSIGHTS_MAX_TASKS_PER_CALL = 500
/** Floor, so a tiny or misconfigured cap still makes progress. */
const INSIGHTS_MIN_TASKS_PER_CALL = 10
/** Thinking budget Insights asks for on Opus models. */
const INSIGHTS_OPUS_THINKING_TOKENS = 10000

/** The thinking budget an Insights call sets for this model (Opus only). */
function insightsThinkingTokens(model: string): number | undefined {
  return model.includes('opus') ? INSIGHTS_OPUS_THINKING_TOKENS : undefined
}

/** Max tasks per Insights call for this provider and model. */
export function insightsTasksPerCall(config: Pick<FeatureAIConfig, 'provider' | 'model'>): number {
  const thinking = insightsThinkingTokens(config.model)
  // OpenAI never sends the thinking budget, so it plans like a model that thinks unasked.
  const explicitThinking = !!thinking && config.provider !== 'openai'
  const budget = outputTokenBudget(config.provider, thinking)
  const perTask = explicitThinking
    ? INSIGHTS_TOKENS_PER_TASK_VISIBLE
    : INSIGHTS_TOKENS_PER_TASK_ADAPTIVE
  const fit = Math.floor((budget * INSIGHTS_OUTPUT_BUDGET_SHARE) / perTask)
  return Math.min(INSIGHTS_MAX_TASKS_PER_CALL, Math.max(INSIGHTS_MIN_TASKS_PER_CALL, fit))
}

/**
 * Fisher-Yates shuffle — returns a new array in random order.
 */
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/**
 * Build a calibration summary of the full task list for overflow chunks.
 * Gives each chunk context about the overall list composition so the LLM
 * can score its subset relative to the whole.
 */
function buildTaskListSummary(tasks: TaskSummary[], now: DateTime): string {
  // Priority distribution
  const pCounts = [0, 0, 0, 0, 0]
  for (const t of tasks) pCounts[t.priority]++
  const priorityLine = pCounts
    .map((count, i) =>
      count > 0 ? `P${i}: ${count} (${Math.round((count / tasks.length) * 100)}%)` : null,
    )
    .filter(Boolean)
    .join(', ')

  // Project breakdown (sorted by count descending)
  const projectCounts = new Map<string, number>()
  for (const t of tasks) {
    const name = t.project_name || 'Inbox'
    projectCounts.set(name, (projectCounts.get(name) || 0) + 1)
  }
  const projectLine = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`)
    .join(', ')

  // Age histogram
  const ageBuckets: Record<string, number> = {
    '<1 week': 0,
    '1-4 weeks': 0,
    '1-3 months': 0,
    '3+ months': 0,
  }
  for (const t of tasks) {
    const days = Math.floor(now.diff(DateTime.fromISO(t.created_at, { zone: 'utc' }), 'days').days)
    if (days < 7) ageBuckets['<1 week']++
    else if (days < 28) ageBuckets['1-4 weeks']++
    else if (days < 90) ageBuckets['1-3 months']++
    else ageBuckets['3+ months']++
  }
  const ageLine = Object.entries(ageBuckets)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`)
    .join(', ')

  return [
    '## Full task list summary (you are scoring a random subset)',
    `Total tasks: ${tasks.length}`,
    `Priority distribution: ${priorityLine}`,
    `Project breakdown: ${projectLine}`,
    `Age: ${ageLine}`,
  ].join('\n')
}

/**
 * Generate insights for a single user and await completion.
 *
 * Unlike startInsightsGeneration (fire-and-forget), this awaits processInsightsChunks
 * directly so the caller blocks until results are cached. Used by the nightly cron
 * to process users sequentially.
 */
export async function generateInsightsForUser(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
  aiConfig?: FeatureAIConfig,
): Promise<void> {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()

  db.prepare(
    `INSERT INTO ai_insights_sessions (id, user_id, status, total_tasks, completed, started_at, heartbeat_at)
     VALUES (?, ?, 'running', ?, 0, ?, ?)`,
  ).run(sessionId, userId, tasks.length, now, now)

  try {
    await processInsightsChunks(sessionId, userId, timezone, tasks, userContext, source, aiConfig)
  } catch (err) {
    log.error('ai', 'Insights generation failed:', err)
    db.prepare(
      `UPDATE ai_insights_sessions SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
    ).run(String(err), nowUtc(), sessionId)
    throw err
  }
}

/**
 * Start an insights generation session and process tasks in background.
 *
 * Returns the session ID immediately. The caller polls getInsightsSessionStatus()
 * to track progress.
 */
export function startInsightsGeneration(
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
  aiConfig?: FeatureAIConfig,
): { sessionId: string; totalTasks: number; singleCall: boolean; startedAt: string } {
  const sessionId = uuid()
  const now = nowUtc()
  const db = getDb()
  // Whether the client gets incremental progress. The config is resolved again
  // (and any error recorded on the session) by processInsightsChunks; a config
  // that cannot resolve here fails there, so the guess does not matter then.
  let singleCall = true
  try {
    singleCall = tasks.length <= insightsTasksPerCall(aiConfig ?? defaultInsightsConfig())
  } catch {
    // Reported as the session's error by processInsightsChunks
  }

  // Create session
  db.prepare(
    `INSERT INTO ai_insights_sessions (id, user_id, status, total_tasks, completed, started_at, heartbeat_at)
     VALUES (?, ?, 'running', ?, 0, ?, ?)`,
  ).run(sessionId, userId, tasks.length, now, now)

  // Start processing in background (fire-and-forget)
  processInsightsChunks(sessionId, userId, timezone, tasks, userContext, source, aiConfig).catch(
    (err) => {
      log.error('ai', 'Insights generation failed:', err)
      db.prepare(
        `UPDATE ai_insights_sessions SET status = 'failed', error = ?, finished_at = ?
       WHERE id = ?`,
      ).run(String(err), nowUtc(), sessionId)
    },
  )

  return { sessionId, totalTasks: tasks.length, singleCall, startedAt: now }
}

/** The Insights config when the caller passes none: the feature's API config. */
function defaultInsightsConfig(): FeatureAIConfig {
  return resolveFeatureAIConfig('insights', 'api')
}

/**
 * Split a (shuffled) list into the fewest calls of at most `tasksPerCall`
 * tasks, sized as equally as possible.
 */
export function splitIntoChunks<T>(items: T[], tasksPerCall: number): T[][] {
  const chunkCount = Math.max(1, Math.ceil(items.length / tasksPerCall))
  const chunkSize = Math.ceil(items.length / chunkCount)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

/** What every Insights call in one run shares. */
interface InsightsRunContext {
  userId: number
  timezone: string
  now: DateTime
  currentTime: string
  allTasks: TaskSummary[]
  scheduleBlock: string
  sourceBlock: string
  userContext?: string | null
  /** Calibration summary of the whole list — built on first use, for subset calls only. */
  summary: () => string
  config: FeatureAIConfig
  timeoutMs: number
}

/**
 * One call's outcome: the scored items, or null with whether a retry as two
 * halves could help — a response cut off at the output cap, or one that came
 * back but did not parse. A call that errored (timeout, network, provider
 * error) is not split: halving the list does not fix those.
 */
type InsightsCallOutcome = { items: InsightsItem[] } | { items: null; retryable: boolean }

/** Run one Insights call over `chunk`; sanitizes the items but does not store them. */
async function callInsights(
  ctx: InsightsRunContext,
  chunk: TaskSummary[],
  label: string,
): Promise<InsightsCallOutcome> {
  const whole = chunk.length === ctx.allTasks.length
  // A call over the whole list states the total; a subset call carries the
  // calibration summary so it can score relative to the full list.
  const prompt = buildInsightsFullPrompt({
    currentTime: ctx.currentTime,
    totalTaskCount: ctx.allTasks.length,
    taskLines: chunk.map((t) => formatTaskLine(t, ctx.timezone, ctx.now)).join('\n'),
    scheduleBlock: ctx.scheduleBlock,
    sourceBlock: ctx.sourceBlock,
    userContext: ctx.userContext,
    summaryBlock: whole ? undefined : ctx.summary(),
    contextBlock: whole
      ? `Total tasks: ${ctx.allTasks.length}`
      : `Total tasks in full list: ${ctx.allTasks.length}\nTasks in this subset: ${chunk.length} (random sample — see summary above)`,
  })

  const { provider, providerConfig, model } = ctx.config
  const maxThinkingTokens = insightsThinkingTokens(model)
  let result: AIQueryResult
  try {
    result = await aiQuery({
      prompt,
      outputSchema: INSIGHTS_JSON_SCHEMA,
      model,
      maxTurns: 1,
      // Extended thinking for Opus models improves scoring quality
      ...(maxThinkingTokens && { maxThinkingTokens }),
      userId: ctx.userId,
      action: 'insights',
      inputText: whole ? `${chunk.length} tasks` : `${label} (${chunk.length} tasks)`,
      timeoutMs: ctx.timeoutMs,
      provider,
      providerConfig,
    })
  } catch (err) {
    log.error('ai', `Insights ${label} error:`, err)
    return { items: null, retryable: false }
  }

  if (result.truncated) {
    log.warn(
      'ai',
      `Insights ${label} truncated: the response hit the output cap (out ${result.outputTokens ?? '?'}) with ${chunk.length} tasks`,
    )
  }

  const parsed = parseAIResponse(result, InsightsBatchResponseSchema, 'Insights', (text) => {
    const json = extractJsonFromText(text)
    if (!json) return null
    // Handle both direct array and { tasks: [...] } wrapper
    const arr = Array.isArray(json) ? json : json.tasks
    if (!Array.isArray(arr)) return null
    const attempt = InsightsBatchResultSchema.safeParse(arr)
    return attempt.success ? attempt.data : null
  })

  if (!parsed) {
    const retryable = !!result.truncated || result.success || result.error === 'No output'
    log.warn('ai', `Insights ${label} failed to parse (${chunk.length} tasks)`)
    return { items: null, retryable }
  }

  // Keep only this chunk's tasks, once each (a hallucinated or repeated id is dropped)
  const taskMap = new Map(chunk.map((t) => [t.id, t]))
  const seen = new Set<number>()
  const items = parsed.filter((item) => {
    if (!taskMap.has(item.task_id) || seen.has(item.task_id)) return false
    seen.add(item.task_id)
    return true
  })
  if (items.length < chunk.length) {
    log.warn(
      'ai',
      `Insights ${label}: AI returned ${items.length}/${chunk.length} tasks (${chunk.length - items.length} missing)`,
    )
  }
  sanitizeSignals(items, taskMap)
  return { items }
}

/**
 * Score one chunk and store its results; returns how many tasks were scored.
 *
 * A chunk that was cut off at the output cap or did not parse is retried
 * once as two halves, each half a single call (no further splitting), so a
 * size estimate that ran short loses no tasks — at most two extra calls.
 */
async function runInsightsChunk(
  ctx: InsightsRunContext,
  chunk: TaskSummary[],
  label: string,
): Promise<number> {
  const outcome = await callInsights(ctx, chunk, label)
  if (outcome.items) {
    storeInsightsResults(ctx.userId, outcome.items)
    return outcome.items.length
  }
  if (!outcome.retryable || chunk.length < 2) {
    log.warn('ai', `Insights ${label}: skipping ${chunk.length} tasks`)
    return 0
  }

  log.warn('ai', `Insights ${label}: retrying its ${chunk.length} tasks once as two halves`)
  const mid = Math.ceil(chunk.length / 2)
  let scored = 0
  for (const [i, half] of [chunk.slice(0, mid), chunk.slice(mid)].entries()) {
    const halfLabel = `${label} half ${i + 1}/2`
    const halfOutcome = await callInsights(ctx, half, halfLabel)
    if (halfOutcome.items) {
      storeInsightsResults(ctx.userId, halfOutcome.items)
      scored += halfOutcome.items.length
    } else {
      log.warn('ai', `Insights ${halfLabel}: skipping ${half.length} tasks`)
    }
  }
  return scored
}

/**
 * Process tasks through the AI — one call when the list fits the call's
 * output budget (`insightsTasksPerCall`), otherwise shuffled equal chunks,
 * each prompt carrying a calibration summary of the full list so the LLM can
 * score relative to the whole.
 */
async function processInsightsChunks(
  sessionId: string,
  userId: number,
  timezone: string,
  tasks: TaskSummary[],
  userContext?: string | null,
  source?: 'scheduled' | 'on-demand',
  aiConfig?: FeatureAIConfig,
): Promise<void> {
  const db = getDb()
  const now = DateTime.now().setZone(timezone)
  const config = aiConfig ?? defaultInsightsConfig()

  let summary: string | null = null
  const ctx: InsightsRunContext = {
    userId,
    timezone,
    now,
    currentTime: now.toFormat("cccc, LLL d, yyyy, h:mm a '('z')'"),
    allTasks: tasks,
    scheduleBlock: getScheduleBlock(userId),
    sourceBlock: source === 'scheduled' ? '\nThis is an automated insights run.\n' : '',
    userContext,
    summary: () => (summary ??= buildTaskListSummary(tasks, now)),
    config,
    timeoutMs: resolveFeatureTimeout(userId, 'insights', config.provider === 'sdk' ? 'sdk' : 'api'),
  }

  const tasksPerCall = insightsTasksPerCall(config)
  const chunks =
    tasks.length <= tasksPerCall ? [tasks] : splitIntoChunks(shuffleArray(tasks), tasksPerCall)
  log.info(
    'ai',
    `Insights: ${tasks.length} tasks in ${chunks.length} call(s) of up to ${tasksPerCall} (${config.provider}, ${config.model})`,
  )

  let scored = 0
  for (let ci = 0; ci < chunks.length; ci++) {
    scored += await runInsightsChunk(ctx, chunks[ci], `chunk ${ci + 1}/${chunks.length}`)
    // Progress counts tasks actually scored, never ones that failed. The
    // heartbeat tells getActiveInsightsSession this run is still alive.
    db.prepare('UPDATE ai_insights_sessions SET completed = ?, heartbeat_at = ? WHERE id = ?').run(
      scored,
      nowUtc(),
      sessionId,
    )
  }

  finishInsightsSession(sessionId, userId, tasks, scored)
}

/**
 * Close a session truthfully (the table's vocabulary: running → complete | failed).
 *
 * - every task scored → `complete`, no error
 * - some scored → `complete`, `completed` = the number scored, and `error`
 *   says how many could not be (the UI treats it as a finished run; the
 *   unscored tasks keep any result from an earlier run)
 * - none scored → `failed` with an error, and earlier results are kept
 *
 * The `AND status = 'running'` guard leaves a session that was auto-failed as
 * stale (or superseded) alone, and stale-result cleanup runs only for a
 * session this run completed.
 */
function finishInsightsSession(
  sessionId: string,
  userId: number,
  tasks: TaskSummary[],
  scored: number,
): void {
  const db = getDb()
  const unscored = tasks.length - scored

  if (tasks.length > 0 && scored === 0) {
    const error = `None of the ${tasks.length} tasks could be scored`
    log.warn('ai', `Insights generation failed: ${error}`)
    db.prepare(
      `UPDATE ai_insights_sessions SET status = 'failed', completed = 0, error = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(error, nowUtc(), sessionId)
    return
  }

  const error = unscored > 0 ? `${unscored} of ${tasks.length} tasks could not be scored` : null
  if (error) log.warn('ai', `Insights generation: ${error}`)

  const updateResult = db
    .prepare(
      `UPDATE ai_insights_sessions SET status = 'complete', completed = ?, error = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(scored, error, nowUtc(), sessionId)

  // Clean up stale results (tasks no longer in the active list) only on completion.
  // Old results are preserved during generation so failures don't wipe data.
  if (updateResult.changes > 0 && tasks.length > 0) {
    const allTaskIds = tasks.map((t) => t.id)
    const placeholders = allTaskIds.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM ai_insights_results WHERE user_id = ? AND task_id NOT IN (${placeholders})`,
    ).run(userId, ...allTaskIds)
  }
}

/**
 * Store insights results for a batch (upsert).
 */
function storeInsightsResults(userId: number, items: InsightsItem[]): void {
  const now = nowUtc()

  withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, task_id) DO UPDATE SET
         score = excluded.score,
         commentary = excluded.commentary,
         signals = excluded.signals,
         generated_at = excluded.generated_at`,
    )

    for (const item of items) {
      const signals = item.signals.length > 0 ? JSON.stringify(item.signals) : null
      stmt.run(userId, item.task_id, item.score, item.commentary, signals, now)
    }
  })
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Get the status of an insights session for progress polling.
 */
export function getInsightsSessionStatus(
  sessionId: string,
  userId: number,
): InsightsSession | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM ai_insights_sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId) as InsightsSession | undefined
  return row ?? null
}

/**
 * Get cached insights results for a user.
 * Returns results sorted by score descending.
 */
export function getInsightsResults(userId: number): {
  results: InsightsResult[]
  generatedAt: string | null
  signalCounts: Record<string, number>
} {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT task_id, score, commentary, signals, generated_at
       FROM ai_insights_results
       WHERE user_id = ?
       ORDER BY score DESC`,
    )
    .all(userId) as {
    task_id: number
    score: number
    commentary: string
    signals: string | null
    generated_at: string
  }[]

  const signalCounts: Record<string, number> = {}
  const results: InsightsResult[] = rows.map((row) => {
    const signals: InsightsSignalKey[] = row.signals ? JSON.parse(row.signals) : []
    for (const s of signals) {
      signalCounts[s] = (signalCounts[s] || 0) + 1
    }
    return {
      task_id: row.task_id,
      score: row.score,
      commentary: row.commentary,
      signals,
      generated_at: row.generated_at,
    }
  })

  return {
    results,
    generatedAt: rows.length > 0 ? rows[0].generated_at : null,
    signalCounts,
  }
}

/**
 * Check if a user has any insights results (for showing cached vs empty state).
 */
export function hasInsightsResults(userId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) as count FROM ai_insights_results WHERE user_id = ?')
    .get(userId) as { count: number }
  return row.count > 0
}

/**
 * A running session with no heartbeat for this long is considered crashed
 * (e.g. a server restart) and auto-failed. The heartbeat moves after every
 * chunk, so a long chunked run (25+ calls of 20 tasks on an 8192-cap model)
 * stays alive as long as it progresses. The bound has to outlast one chunk:
 * a call up to its timeout (300s on the SDK, 180s on the API) plus, when it
 * is cut off, its two halves — 15 minutes at worst — so 20 minutes holds.
 */
const SESSION_STALE_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Get the duration in milliseconds of the most recent finished insights session
 * (complete or failed), so a failed run is not masked by an older good one.
 */
export function getLastInsightsDurationMs(userId: number): number | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT started_at, finished_at FROM ai_insights_sessions
       WHERE user_id = ? AND status IN ('complete', 'failed') AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(userId) as { started_at: string; finished_at: string } | undefined
  if (!row) return null
  return new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()
}

/**
 * How many tasks the most recent finished Insights run (complete or failed)
 * could not score — 0 when it scored them all, or there is none. A run that
 * scored only some tasks finishes `complete` with `completed` counting the
 * scored ones; a failed run scored none. The panel shows it as a quiet line
 * ("N tasks couldn't be scored"), and a newer failure is not masked by an
 * older good run.
 */
export function getLastInsightsUnscoredCount(userId: number): number {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT total_tasks, completed FROM ai_insights_sessions
       WHERE user_id = ? AND status IN ('complete', 'failed') AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(userId) as { total_tasks: number; completed: number } | undefined
  return row ? Math.max(0, row.total_tasks - row.completed) : 0
}

/**
 * Get the most recent active session for a user (if any is still running).
 * Auto-fails sessions with no heartbeat for SESSION_STALE_TIMEOUT_MS to prevent
 * permanent 409s after server restarts kill background generation.
 */
export function getActiveInsightsSession(userId: number): InsightsSession | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT * FROM ai_insights_sessions
       WHERE user_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId) as InsightsSession | undefined
  if (!row) return null

  // Sessions from before the heartbeat column have none: judge them from their start
  const lastSignOfLife = row.heartbeat_at ?? row.started_at
  const silentMs = Date.now() - new Date(lastSignOfLife).getTime()
  if (silentMs > SESSION_STALE_TIMEOUT_MS) {
    db.prepare(
      `UPDATE ai_insights_sessions SET status = 'failed', error = 'Generation timed out', finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(nowUtc(), row.id)
    return null
  }

  return row
}
