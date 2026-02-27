/**
 * Claude Agent SDK wrapper
 *
 * Provides a simplified interface for AI queries with error handling,
 * duration measurement, and activity logging. The SDK spawns Claude Code
 * subprocesses — it uses the server's existing Claude Code authentication
 * (Max subscription), so no API key is needed.
 */

import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { logAIActivity } from './activity'
import { withSlot } from './queue'
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk'

let aiEnabled: boolean | null = null

/**
 * Check if AI features are enabled.
 * Reads OPENTASK_AI_ENABLED env var (default: false).
 */
export function isAIEnabled(): boolean {
  if (aiEnabled === null) {
    aiEnabled = process.env.OPENTASK_AI_ENABLED === 'true'
  }
  return aiEnabled
}

/**
 * Initialize AI subsystem. Called from instrumentation.ts on server startup.
 * Validates that the SDK is importable and logs the AI status.
 */
export async function initAI(): Promise<void> {
  if (!isAIEnabled()) {
    log.info('ai', 'AI features disabled (OPENTASK_AI_ENABLED != true)')
    return
  }

  try {
    // Verify the SDK is installed and importable
    await import('@anthropic-ai/claude-agent-sdk')
    log.info('ai', 'AI features enabled — Claude Agent SDK loaded')
  } catch {
    log.error(
      'ai',
      'AI features enabled but SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    )
    aiEnabled = false
  }
}

export interface AIQueryOptions {
  /** The prompt to send to the model */
  prompt: string
  /** JSON Schema for structured output (optional) */
  outputSchema?: Record<string, unknown>
  /** Model to use (default: 'haiku'). Each feature should read its own env var. */
  model?: string
  /** Maximum conversation turns (default: 3) */
  maxTurns?: number
  /** Maximum thinking tokens for extended thinking (Opus 4.6). Omit to disable. */
  maxThinkingTokens?: number
  /** User ID for activity logging */
  userId: number
  /** Task ID for activity logging (optional) */
  taskId?: number
  /** Action name for activity logging (e.g., 'enrich') */
  action: string
  /** Raw input text for activity logging */
  inputText?: string
  /** Per-call timeout in ms. Overrides OPENTASK_AI_QUERY_TIMEOUT_MS when provided. */
  timeoutMs?: number
}

export interface AIQueryResult {
  /** The structured output from the model, or null on failure */
  structuredOutput: Record<string, unknown> | null
  /** The raw text result from the model */
  textResult: string | null
  /** Duration of the query in milliseconds */
  durationMs: number
  /** Whether the query succeeded */
  success: boolean
  /** Error message if the query failed */
  error: string | null
}

/** Default timeout for SDK queries (60 seconds) */
const DEFAULT_QUERY_TIMEOUT_MS = 60_000

/**
 * Execute an AI query via the Claude Agent SDK.
 *
 * Wraps the SDK's query() function with:
 * - Error handling (catch SDK errors, log, return null)
 * - Duration measurement
 * - Activity logging (writes to ai_activity_log)
 * - Request timeout (kills subprocess via AbortController)
 */

export async function aiQuery(options: AIQueryOptions): Promise<AIQueryResult> {
  const {
    prompt,
    outputSchema,
    model,
    maxTurns = 3,
    maxThinkingTokens,
    userId,
    taskId,
    action,
    inputText,
    timeoutMs: perCallTimeout,
  } = options

  const resolvedModel = model || 'haiku'
  const startTime = Date.now()
  const timeoutMs =
    perCallTimeout ??
    parseInt(process.env.OPENTASK_AI_QUERY_TIMEOUT_MS || String(DEFAULT_QUERY_TIMEOUT_MS), 10)

  let timedOut = false

  try {
    // Acquire a semaphore slot to limit concurrent SDK subprocesses.
    // The slot is released after the query completes (success or failure).
    return await withSlot(async () => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')

      // Build query options using the SDK's Options type.
      // bypassPermissions requires allowDangerouslySkipPermissions safety flag.
      // persistSession=false avoids writing enrichment sessions to ~/.claude/.
      // pathToClaudeCodeExecutable resolves the globally installed CLI when
      // running inside a bundled Next.js standalone app (where the SDK's
      // default resolution finds the wrong cli.js).
      const queryOptions: Options = {
        model: resolvedModel,
        maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        ...(maxThinkingTokens && { maxThinkingTokens }),
        ...(process.env.OPENTASK_AI_CLI_PATH && {
          pathToClaudeCodeExecutable: process.env.OPENTASK_AI_CLI_PATH,
        }),
      }

      if (outputSchema) {
        queryOptions.outputFormat = {
          type: 'json_schema',
          schema: outputSchema,
        }
      }

      let structuredOutput: Record<string, unknown> | null = null
      let textResult: string | null = null

      log.debug('ai', `${action} starting (model: ${resolvedModel}, timeout: ${timeoutMs}ms)`)

      // Wrap the SDK query in a timeout to prevent hanging subprocesses.
      // The AbortController is passed to the SDK options to kill the subprocess.
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      queryOptions.abortController = controller

      try {
        for await (const message of query({ prompt, options: queryOptions })) {
          // Only extract results from successful completions
          if (message.type === 'result' && message.subtype === 'success') {
            const result = message as SDKResultSuccess
            if (result.structured_output) {
              structuredOutput = result.structured_output as Record<string, unknown>
            }
            // result.result is the text output; can be empty string
            if (result.result != null && result.result !== '') {
              textResult = result.result
            }
          } else if (message.type === 'result') {
            // Non-success result — log for debugging
            log.debug('ai', `${action} received result with subtype: ${message.subtype}`)
          }
        }
      } finally {
        clearTimeout(timeout)
      }

      const durationMs = Date.now() - startTime

      // The SDK subprocess completed, but check if we actually got usable output.
      // Empty output means the model ran but produced nothing parseable — log as
      // error so the activity log accurately reflects whether we got a result.
      const hasOutput = !!(structuredOutput || textResult)

      if (!hasOutput) {
        log.warn('ai', `${action} completed but returned no output (${durationMs}ms)`)
      }

      logAIActivity({
        user_id: userId,
        task_id: taskId ?? null,
        action,
        status: hasOutput ? 'success' : 'error',
        input: inputText ?? null,
        output: structuredOutput ? JSON.stringify(structuredOutput) : textResult,
        model: resolvedModel,
        duration_ms: durationMs,
        error: hasOutput ? null : 'Subprocess completed but returned no output',
      })

      log.info('ai', `${action} completed in ${durationMs}ms (model: ${resolvedModel})`)

      return {
        structuredOutput,
        textResult,
        durationMs,
        success: hasOutput,
        error: hasOutput ? null : 'No output',
      }
    })
  } catch (err) {
    return handleQueryError(err, startTime, timedOut, {
      userId,
      taskId,
      action,
      inputText,
      resolvedModel,
    })
  }
}

/** Build error result, log activity, and return failure response */
function handleQueryError(
  err: unknown,
  startTime: number,
  timedOut: boolean,
  ctx: {
    userId: number
    taskId?: number
    action: string
    inputText?: string
    resolvedModel: string
  },
): AIQueryResult {
  const durationMs = Date.now() - startTime

  const errorMessage = timedOut
    ? `Query timed out after ${durationMs}ms`
    : err instanceof Error
      ? err.message
      : String(err)

  logAIActivity({
    user_id: ctx.userId,
    task_id: ctx.taskId ?? null,
    action: ctx.action,
    status: 'error',
    input: ctx.inputText ?? null,
    output: null,
    model: ctx.resolvedModel,
    duration_ms: durationMs,
    error: errorMessage,
  })

  notifyError('ai-failure', `AI ${ctx.action} failed`, errorMessage)

  if (timedOut) {
    log.warn('ai', `${ctx.action} timed out after ${durationMs}ms`)
  } else {
    log.error('ai', `${ctx.action} failed after ${durationMs}ms:`, err)
  }

  return {
    structuredOutput: null,
    textResult: null,
    durationMs,
    success: false,
    error: errorMessage,
  }
}
