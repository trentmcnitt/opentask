/**
 * Anthropic Messages API provider
 *
 * Direct HTTP calls to the Anthropic API via @anthropic-ai/sdk.
 * Alternative to the Claude Agent SDK (subprocess-based) provider.
 *
 * Advantages over SDK provider:
 * - No Claude Code installation required (works in Docker)
 * - No subprocess overhead (faster for simple queries)
 * - Stateless HTTP calls (no warm slot machinery needed)
 *
 * Supports per-feature API keys via FeatureProviderConfig.
 */

import Anthropic from '@anthropic-ai/sdk'
import { log } from '@/lib/logger'
import { logAIActivity } from './activity'
import { resolveModelId } from './provider'
import { handleQueryError, resolveQueryTimeout } from './sdk'
import type { AIQueryOptions, AIQueryResult } from './sdk'

/** Cache of Anthropic clients keyed by API key. */
const clients = new Map<string, Anthropic>()

function getClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || ''
  let client = clients.get(key)
  if (!client) {
    client = new Anthropic({ apiKey: key || undefined })
    clients.set(key, client)
  }
  return client
}

/**
 * Execute an AI query via the Anthropic Messages API.
 *
 * Mirrors the interface of aiQuery() from sdk.ts — same input options,
 * same output shape. Callers don't need to know which provider is being used.
 */
export async function apiQuery(options: AIQueryOptions): Promise<AIQueryResult> {
  const {
    prompt,
    outputSchema,
    systemPrompt,
    model,
    maxThinkingTokens,
    userId,
    taskId,
    action,
    inputText,
    timeoutMs: perCallTimeout,
    providerConfig,
  } = options

  const resolvedModel = resolveModelId(model)
  const startTime = Date.now()
  const timeoutMs = resolveQueryTimeout(perCallTimeout)
  let timedOut = false

  try {
    const anthropic = getClient(providerConfig?.apiKey)

    // Build the create params
    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: resolvedModel,
      max_tokens: maxThinkingTokens ? 16384 : 8192,
      messages: [{ role: 'user', content: prompt }],
    }

    // System prompt
    if (systemPrompt) {
      createParams.system = systemPrompt
    }

    // Structured output via json_schema format
    if (outputSchema) {
      createParams.output_config = {
        format: {
          type: 'json_schema',
          schema: sanitizeSchemaForAnthropic(
            outputSchema,
          ) as Anthropic.Messages.JSONOutputFormat['schema'],
        },
      }
    }

    // Extended thinking (for Opus with deep analysis)
    if (maxThinkingTokens) {
      createParams.thinking = {
        type: 'enabled',
        budget_tokens: maxThinkingTokens,
      }
    }

    log.debug('ai', `[api] ${action} starting (model: ${resolvedModel}, timeout: ${timeoutMs}ms)`)

    // Timeout via AbortController
    const controller = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    let response: Anthropic.Message
    try {
      response = await anthropic.messages.create(createParams, {
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // Extract content from response
    let structuredOutput: Record<string, unknown> | null = null
    let textResult: string | null = null

    for (const block of response.content) {
      if (block.type === 'text') {
        textResult = block.text
        // When using json_schema output format, the text IS the JSON
        if (outputSchema && textResult) {
          try {
            structuredOutput = JSON.parse(textResult)
          } catch {
            log.warn('ai', `[api] ${action}: response text is not valid JSON`)
          }
        }
      }
    }

    const durationMs = Date.now() - startTime
    const hasOutput = !!(structuredOutput || textResult)

    if (!hasOutput) {
      log.warn('ai', `[api] ${action} completed but returned no output (${durationMs}ms)`)
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
      error: hasOutput ? null : 'API response contained no usable output',
      provider: 'anthropic',
    })

    log.info('ai', `[api] ${action} completed in ${durationMs}ms (model: ${resolvedModel})`)

    return {
      structuredOutput,
      textResult,
      durationMs,
      success: hasOutput,
      error: hasOutput ? null : 'No output',
    }
  } catch (err) {
    return handleQueryError(err, startTime, timedOut, {
      userId,
      taskId,
      action,
      inputText,
      model: resolvedModel,
      provider: 'anthropic',
    })
  }
}

/**
 * Strip JSON Schema properties that Anthropic's output_config doesn't support.
 * Zod's toJSONSchema() emits standard properties like minimum/maximum on integers
 * that the Anthropic API rejects. Recursively clean the schema before sending.
 */
const UNSUPPORTED_NUMERIC_PROPS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]
const UNSUPPORTED_STRING_PROPS = ['minLength', 'maxLength', 'pattern']
const UNSUPPORTED_ARRAY_PROPS = ['minItems', 'maxItems', 'uniqueItems']

function sanitizeSchemaForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  const type = result.type as string | undefined
  if (type === 'integer' || type === 'number') {
    for (const prop of UNSUPPORTED_NUMERIC_PROPS) delete result[prop]
  } else if (type === 'string') {
    for (const prop of UNSUPPORTED_STRING_PROPS) delete result[prop]
  } else if (type === 'array') {
    for (const prop of UNSUPPORTED_ARRAY_PROPS) delete result[prop]
    if (result.items) {
      result.items = sanitizeSchemaForAnthropic(result.items as Record<string, unknown>)
    }
  } else if (type === 'object' && result.properties) {
    const props = result.properties as Record<string, Record<string, unknown>>
    result.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, sanitizeSchemaForAnthropic(v)]),
    )
  }

  // Handle anyOf/oneOf/allOf
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(sanitizeSchemaForAnthropic)
    }
  }

  return result
}
