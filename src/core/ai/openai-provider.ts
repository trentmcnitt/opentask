/**
 * OpenAI-compatible API provider
 *
 * Direct HTTP calls via the openai npm SDK.
 * Supports OpenAI, OpenRouter, Ollama, Together, Groq, and any
 * provider implementing the OpenAI chat completions API.
 *
 * Requires OPENAI_API_KEY environment variable.
 * Optional OPENAI_BASE_URL for non-OpenAI endpoints (default: https://api.openai.com/v1).
 * Optional OPENAI_MODEL for default model selection (default: gpt-4o-mini).
 */

import OpenAI from 'openai'
import { log } from '@/lib/logger'
import { logAIActivity } from './activity'
import { handleQueryError, resolveQueryTimeout } from './sdk'
import type { AIQueryOptions, AIQueryResult } from './sdk'

let client: OpenAI | null = null

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY
    const baseURL = process.env.OPENAI_BASE_URL
    log.debug(
      'ai',
      `[openai] creating client (key: ${apiKey ? apiKey.slice(0, 8) + '...' : 'MISSING'}, baseURL: ${baseURL || 'default'})`,
    )
    client = new OpenAI({
      apiKey,
      ...(baseURL && { baseURL }),
    })
  }
  return client
}

// Schema name lookup for OpenAI's json_schema response_format (requires a name field)
const SCHEMA_NAMES: Record<string, string> = {
  enrich: 'enrichment_result',
  whats_next: 'whats_next_result',
  insights: 'insights_result',
  quick_take: 'quick_take_result',
}

/**
 * Execute an AI query via an OpenAI-compatible API.
 *
 * Mirrors the interface of apiQuery() from api-provider.ts — same input options,
 * same output shape. Callers don't need to know which provider is being used.
 */
export async function openaiQuery(options: AIQueryOptions): Promise<AIQueryResult> {
  const {
    prompt,
    outputSchema,
    systemPrompt,
    model,
    userId,
    taskId,
    action,
    inputText,
    timeoutMs: perCallTimeout,
  } = options

  const startTime = Date.now()
  const timeoutMs = resolveQueryTimeout(perCallTimeout)
  let timedOut = false

  try {
    const openai = getClient()

    // Build messages array
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: model,
      messages,
    }

    // Structured output via response_format
    if (outputSchema) {
      const useStrict = process.env.OPENTASK_AI_OPENAI_STRICT !== 'false'
      // OpenAI requires the top-level schema to be type: "object". If the schema
      // is an array (e.g., insights batch), wrap it in an object with a "data" key.
      const effectiveSchema =
        outputSchema.type === 'array'
          ? {
              type: 'object',
              properties: { data: outputSchema },
              required: ['data'],
              additionalProperties: false,
            }
          : outputSchema
      createParams.response_format = {
        type: 'json_schema',
        json_schema: {
          name: SCHEMA_NAMES[action] || `${action}_result`,
          schema: effectiveSchema,
          ...(useStrict ? { strict: true } : {}),
        },
      }
    }

    // maxThinkingTokens is Anthropic-specific — skipped for OpenAI

    log.debug('ai', `[openai] ${action} starting (model: ${model}, timeout: ${timeoutMs}ms)`)

    // Timeout via AbortController
    const controller = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    let response: OpenAI.ChatCompletion
    try {
      response = await openai.chat.completions.create(createParams, {
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // Extract content from response
    let structuredOutput: Record<string, unknown> | null = null
    let textResult: string | null = null

    const content = response.choices[0]?.message?.content
    if (content) {
      textResult = content
      if (outputSchema) {
        try {
          let parsed = JSON.parse(content)
          // Unwrap the object wrapper we added for array schemas
          if (
            outputSchema.type === 'array' &&
            parsed &&
            typeof parsed === 'object' &&
            'data' in parsed
          ) {
            parsed = parsed.data
          }
          structuredOutput = parsed
        } catch {
          log.warn('ai', `[openai] ${action}: response content is not valid JSON`)
        }
      }
    }

    const durationMs = Date.now() - startTime
    const hasOutput = !!(structuredOutput || textResult)

    if (!hasOutput) {
      log.warn('ai', `[openai] ${action} completed but returned no output (${durationMs}ms)`)
    }

    logAIActivity({
      user_id: userId,
      task_id: taskId ?? null,
      action,
      status: hasOutput ? 'success' : 'error',
      input: inputText ?? null,
      output: structuredOutput ? JSON.stringify(structuredOutput) : textResult,
      model: model,
      duration_ms: durationMs,
      error: hasOutput ? null : 'OpenAI response contained no usable output',
      provider: 'openai',
    })

    log.info('ai', `[openai] ${action} completed in ${durationMs}ms (model: ${model})`)

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
      model: model,
      provider: 'openai',
    })
  }
}
