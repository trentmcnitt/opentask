/**
 * AI query dispatcher
 *
 * Central entry point for all AI queries. Dispatches to:
 * - Claude Agent SDK (subprocess-based, requires Claude Code installed)
 * - Anthropic Messages API (direct HTTP, requires ANTHROPIC_API_KEY)
 * - OpenAI-compatible API (direct HTTP, requires OPENAI_API_KEY;
 *   supports OpenAI, OpenRouter, Ollama, Together, Groq, etc.)
 *
 * The provider is determined per-request based on:
 * 1. Explicit `provider` option on the call (per-feature mode: sdk or api)
 * 2. Server-level default (OPENTASK_AI_PROVIDER env var)
 * 3. Auto-detection (SDK → Anthropic → OpenAI, first available wins)
 */

import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { logAIActivity } from './activity'
import { withSlot } from './queue'
import {
  type AIProvider,
  isSdkAvailable,
  isAnthropicAvailable,
  isOpenAIAvailable,
  getServerDefaultProvider,
  resolveModelId,
} from './provider'
import {
  AI_FEATURES,
  resolveFeatureModel,
  resolveSDKModel,
  resolveFeatureProvider,
  type FeatureProviderConfig,
} from './models'
import { getUserQueryTimeout } from './user-context'
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
 *
 * Detects available providers and validates configuration. If the configured
 * provider is unavailable, attempts auto-fallback to the next available one.
 */
export async function initAI(): Promise<void> {
  if (!isAIEnabled()) {
    log.info('ai', 'AI features disabled (OPENTASK_AI_ENABLED != true)')
    return
  }

  const sdkOk = await isSdkAvailable()
  const anthropicOk = isAnthropicAvailable()
  const openaiOk = isOpenAIAvailable()

  // Expose detection results as env vars so route handlers (which may run in
  // a different Next.js module context) can read them via isSdkAvailableSync().
  if (sdkOk) process.env._OPENTASK_SDK_DETECTED = '1'

  if (!sdkOk && !anthropicOk && !openaiOk) {
    log.error(
      'ai',
      'AI features enabled but no provider available. Install Claude Code (SDK), set ANTHROPIC_API_KEY, or set OPENAI_API_KEY.',
    )
    aiEnabled = false
    return
  }

  const defaultProvider = getServerDefaultProvider()

  // Validate the configured provider is available, auto-fallback if not
  const providerAvailable: Record<AIProvider, boolean> = {
    sdk: sdkOk,
    anthropic: anthropicOk,
    openai: openaiOk,
  }

  let effective = defaultProvider
  if (!providerAvailable[defaultProvider]) {
    // Find the first available fallback (SDK → Anthropic → OpenAI)
    const fallback = (['sdk', 'anthropic', 'openai'] as const).find((p) => providerAvailable[p])
    if (fallback) {
      log.warn(
        'ai',
        `${defaultProvider} provider requested but not available. Falling back to ${fallback}.`,
      )
      process.env.OPENTASK_AI_PROVIDER = fallback
      effective = fallback
    } else {
      log.error('ai', `${defaultProvider} provider selected but not available.`)
      aiEnabled = false
      return
    }
  }

  const available = [sdkOk && 'sdk', anthropicOk && 'anthropic', openaiOk && 'openai']
    .filter(Boolean)
    .join(', ')
  log.info('ai', `AI features enabled — default provider: ${effective}, available: [${available}]`)

  // Log resolved config per feature showing both SDK and API model info.
  // SDK models always resolve (fallback to 'sonnet'). API models may not be configured.
  const configLines: string[] = []
  for (const feature of AI_FEATURES) {
    const parts: string[] = []

    // SDK model (always resolves via fallback chain)
    const sdkModel = resolveSDKModel(feature)
    parts.push(`sdk: ${sdkModel}`)

    // API model + provider (may not be configured)
    const apiModel = resolveFeatureModel(feature)
    if (apiModel) {
      try {
        const providerConfig = resolveFeatureProvider(feature)
        if (providerConfig) {
          const maskedKey = providerConfig.apiKey.slice(0, 8) + '...'
          const baseUrlInfo = providerConfig.baseUrl ? `, url: ${providerConfig.baseUrl}` : ''
          parts.push(
            `api: ${apiModel} via ${providerConfig.providerType} (key: ${maskedKey}${baseUrlInfo})`,
          )
        } else {
          parts.push(`api: ${apiModel} (no API provider)`)
        }
      } catch {
        parts.push(`api: ${apiModel} (provider config error)`)
      }
    } else {
      parts.push('api: not configured')
    }

    configLines.push(`  ${feature}: ${parts.join(' | ')}`)
  }
  if (configLines.length > 0) {
    log.info('ai', `Feature configs:\n${configLines.join('\n')}`)
  }
}

export interface AIQueryOptions {
  /** The prompt to send to the model */
  prompt: string
  /** JSON Schema for structured output (optional) */
  outputSchema?: Record<string, unknown>
  /** System prompt (passed to SDK and API providers) */
  systemPrompt?: string
  /** Model to use. Callers must resolve via requireFeatureModel() before calling. */
  model: string
  /** Maximum conversation turns (default: 3, SDK only) */
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
  /** Override provider for this call. If not set, uses server default. */
  provider?: AIProvider
  /** Per-feature provider config (API key, base URL). Passed to API providers. */
  providerConfig?: FeatureProviderConfig
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

/** Default timeout for AI queries (60 seconds). Shared by all providers. */
export const DEFAULT_QUERY_TIMEOUT_MS = 60_000

/** Resolve the effective timeout for an AI query (per-call override → env var → default). */
export function resolveQueryTimeout(perCallTimeout: number | undefined): number {
  return (
    perCallTimeout ??
    parseInt(process.env.OPENTASK_AI_QUERY_TIMEOUT_MS || String(DEFAULT_QUERY_TIMEOUT_MS), 10)
  )
}

/**
 * Execute an AI query, dispatching to the appropriate provider.
 *
 * - SDK: spawns a Claude Code subprocess with the SDK's query() function
 * - Anthropic: direct HTTP call to the Anthropic Messages API
 * - OpenAI: direct HTTP call to an OpenAI-compatible API
 */
export async function aiQuery(options: AIQueryOptions): Promise<AIQueryResult> {
  // Resolve per-user timeout: if no explicit per-call timeout, check user preference
  if (options.timeoutMs == null && options.userId) {
    const userTimeout = getUserQueryTimeout(options.userId)
    if (userTimeout != null) {
      options = { ...options, timeoutMs: userTimeout }
    }
  }

  const provider = options.provider ?? getServerDefaultProvider()

  if (provider === 'anthropic') {
    const { apiQuery } = await import('./api-provider')
    return apiQuery(options)
  }

  if (provider === 'openai') {
    const { openaiQuery } = await import('./openai-provider')
    return openaiQuery(options)
  }

  return sdkQuery(options)
}

/**
 * Execute an AI query via the Claude Agent SDK (subprocess-based).
 *
 * Wraps the SDK's query() function with:
 * - Error handling (catch SDK errors, log, return null)
 * - Duration measurement
 * - Activity logging (writes to ai_activity_log)
 * - Request timeout (kills subprocess via AbortController)
 * - Semaphore (limits concurrent subprocesses)
 */
async function sdkQuery(options: AIQueryOptions): Promise<AIQueryResult> {
  const {
    prompt,
    systemPrompt,
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

  const resolvedModel = resolveModelId(model)
  const startTime = Date.now()
  const timeoutMs = resolveQueryTimeout(perCallTimeout)

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
        // Clear NODE_OPTIONS to prevent debugger bootloaders (VS Code, etc.)
        // from being inherited by the Claude CLI subprocess, which causes
        // it to crash with exit code 1.
        env: { ...process.env, NODE_OPTIONS: '' },
        ...(systemPrompt && { systemPrompt }),
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

      log.debug('ai', `[sdk] ${action} starting (model: ${resolvedModel}, timeout: ${timeoutMs}ms)`)

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
        provider: 'sdk',
      })

      log.info('ai', `[sdk] ${action} completed in ${durationMs}ms (model: ${resolvedModel})`)

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
      model: resolvedModel,
      provider: 'sdk',
    })
  }
}

/** Build error result, log activity, and return failure response. Shared by all providers. */
export function handleQueryError(
  err: unknown,
  startTime: number,
  timedOut: boolean,
  ctx: {
    userId: number
    taskId?: number
    action: string
    inputText?: string
    model: string
    provider: AIProvider
  },
): AIQueryResult {
  const durationMs = Date.now() - startTime
  const prefix = ctx.provider !== 'sdk' ? `[${ctx.provider}] ` : ''

  const errorMessage = timedOut
    ? `${prefix ? `${ctx.provider} query` : 'Query'} timed out after ${durationMs}ms`
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
    model: ctx.model,
    duration_ms: durationMs,
    error: errorMessage,
    provider: ctx.provider,
  })

  notifyError(
    'ai-failure',
    `AI ${ctx.action} failed${prefix ? ` (${ctx.provider})` : ''}`,
    errorMessage,
  )

  if (timedOut) {
    log.warn('ai', `${prefix}${ctx.action} timed out after ${durationMs}ms`)
  } else {
    log.error('ai', `${prefix}${ctx.action} failed after ${durationMs}ms:`, err)
  }

  return {
    structuredOutput: null,
    textResult: null,
    durationMs,
    success: false,
    error: errorMessage,
  }
}
