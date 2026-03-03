/**
 * API-mode enrichment query
 *
 * Direct HTTP call for task enrichment via Anthropic or OpenAI-compatible API.
 * Used instead of the warm slot (enrichment-slot.ts) when the user's
 * provider is not 'sdk'. No subprocess, no warm slot machinery —
 * each call is a stateless HTTP request.
 */

import { aiQuery } from './sdk'
import type { AIProvider } from './provider'
import { ENRICHMENT_SYSTEM_PROMPT } from './prompts'
import { EnrichmentResultSchema } from './types'
import type { FeatureProviderConfig } from './models'
import { z } from 'zod'

/** Pre-computed JSON schema for enrichment output (EnrichmentResultSchema is static). */
const ENRICHMENT_JSON_SCHEMA = z.toJSONSchema(EnrichmentResultSchema) as Record<string, unknown>

/**
 * Enrich a task via a direct API call (Anthropic or OpenAI-compatible).
 *
 * Returns the same shape as enrichmentQuery() from enrichment-slot.ts
 * so the caller doesn't need to know which provider is being used.
 */
export async function enrichmentApiQuery(
  prompt: string,
  options?: {
    userId?: number
    taskId?: number
    inputText?: string
    timeoutMs?: number
    provider?: AIProvider
    providerConfig?: FeatureProviderConfig
    model?: string
  },
): Promise<{
  structuredOutput: Record<string, unknown> | null
  text: string | null
  durationMs: number
}> {
  const provider = options?.provider ?? 'anthropic'
  const model = options?.model
  if (!model) {
    throw new Error('No model configured for enrichment. Set OPENTASK_AI_ENRICHMENT_MODEL.')
  }

  const result = await aiQuery({
    prompt,
    systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
    outputSchema: ENRICHMENT_JSON_SCHEMA,
    model,
    maxTurns: 1,
    userId: options?.userId ?? 0,
    action: 'enrich',
    taskId: options?.taskId,
    inputText: options?.inputText,
    timeoutMs: options?.timeoutMs,
    provider,
    providerConfig: options?.providerConfig,
  })

  return {
    structuredOutput: result.structuredOutput,
    text: result.textResult,
    durationMs: result.durationMs,
  }
}
