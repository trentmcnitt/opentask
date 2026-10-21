/**
 * Behavioral tests for the providers' output caps and truncation detection.
 *
 * The Anthropic API provider sends the cap from output-limits.ts and reports a
 * response that stopped at it as `truncated` — Insights splits such a chunk
 * in half instead of dropping it. The Anthropic and OpenAI clients are mocked.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const anthropicCreate = vi.fn()
const openaiCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } }
  },
}))
vi.mock('@/core/ai/activity', () => ({ logAIActivity: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}))

import { apiQuery } from '@/core/ai/api-provider'
import { openaiQuery } from '@/core/ai/openai-provider'
import {
  anthropicMaxTokens,
  outputTokenBudget,
  outputTokenCap,
  SDK_DEFAULT_MAX_OUTPUT_TOKENS,
} from '@/core/ai/output-limits'
import { log } from '@/lib/logger'

const baseOptions = {
  prompt: 'Score these tasks',
  outputSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
  model: 'claude-haiku-5-5',
  userId: 1,
  action: 'insights',
}

function anthropicMessage(text: string, stopReason: string, outputTokens: number) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: outputTokens },
  }
}

beforeEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  vi.mocked(log.warn).mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('output-limits', () => {
  test('the Anthropic cap is 8192, or 16384 with thinking', () => {
    expect(anthropicMaxTokens()).toBe(8192)
    expect(anthropicMaxTokens(10000)).toBe(16384)
  })

  test('the answer budget is the cap minus the thinking budget', () => {
    expect(outputTokenBudget('anthropic')).toBe(8192)
    expect(outputTokenBudget('anthropic', 10000)).toBe(6384)
    expect(outputTokenBudget('sdk', 10000)).toBe(SDK_DEFAULT_MAX_OUTPUT_TOKENS - 10000)
    // OpenAI never sends a thinking budget, so nothing comes off
    expect(outputTokenBudget('openai', 10000)).toBe(8192)
  })

  test('the SDK cap follows CLAUDE_CODE_MAX_OUTPUT_TOKENS when set', () => {
    expect(outputTokenCap('sdk')).toBe(SDK_DEFAULT_MAX_OUTPUT_TOKENS)
    vi.stubEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '64000')
    expect(outputTokenCap('sdk')).toBe(64000)
  })
})

describe('Anthropic API provider', () => {
  test('sends the shared cap as max_tokens', async () => {
    anthropicCreate.mockResolvedValue(anthropicMessage('{"tasks":[]}', 'end_turn', 20))
    await apiQuery({ ...baseOptions, provider: 'anthropic' })
    expect(anthropicCreate.mock.calls[0][0].max_tokens).toBe(anthropicMaxTokens())

    await apiQuery({ ...baseOptions, provider: 'anthropic', maxThinkingTokens: 10000 })
    expect(anthropicCreate.mock.calls[1][0].max_tokens).toBe(anthropicMaxTokens(10000))
  })

  test('a complete answer is not truncated', async () => {
    anthropicCreate.mockResolvedValue(anthropicMessage('{"tasks":[]}', 'end_turn', 20))
    const result = await apiQuery({ ...baseOptions, provider: 'anthropic' })
    expect(result.truncated).toBe(false)
    expect(result.outputTokens).toBe(20)
    expect(result.structuredOutput).toEqual({ tasks: [] })
  })

  test('stop_reason max_tokens is reported and logged as truncated', async () => {
    anthropicCreate.mockResolvedValue(anthropicMessage('{"tasks":[{"task_', 'max_tokens', 8192))
    const result = await apiQuery({ ...baseOptions, provider: 'anthropic' })
    expect(result.truncated).toBe(true)
    expect(result.outputTokens).toBe(8192)
    expect(result.structuredOutput).toBeNull()
    expect(vi.mocked(log.warn).mock.calls.some(([, msg]) => /truncated/.test(String(msg)))).toBe(
      true,
    )
  })

  test('output tokens equal to the cap count as truncated', async () => {
    anthropicCreate.mockResolvedValue(anthropicMessage('', 'end_turn', 8192))
    const result = await apiQuery({ ...baseOptions, provider: 'anthropic' })
    expect(result.truncated).toBe(true)
  })
})

describe('OpenAI provider', () => {
  test("finish_reason 'length' is reported as truncated", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"tasks":[{"task_' }, finish_reason: 'length' }],
      usage: { completion_tokens: 8192 },
    })
    const result = await openaiQuery({ ...baseOptions, model: 'gpt-5', provider: 'openai' })
    expect(result.truncated).toBe(true)
    expect(result.outputTokens).toBe(8192)
  })

  test("finish_reason 'stop' is not", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"tasks":[]}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 12 },
    })
    const result = await openaiQuery({ ...baseOptions, model: 'gpt-5', provider: 'openai' })
    expect(result.truncated).toBe(false)
  })
})
