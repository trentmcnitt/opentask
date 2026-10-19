/**
 * The options a cold SDK query (aiQuery with provider 'sdk') hands the Claude
 * Agent SDK. The SDK is mocked: these pin what OpenTask asks for, which the
 * SDK turns into CLI flags.
 *
 * - settingSources: [] keeps the CLI off every settings file (Agent SDK 0.2.x
 *   did this by default; 0.3 needs it passed — see sdk-options.ts).
 * - A thinking budget goes as `thinking: { type: 'enabled', budgetTokens }`,
 *   which 0.3 sends as `--max-thinking-tokens N`, the flag 0.2.x sent for the
 *   now-deprecated `maxThinkingTokens`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/core/ai/activity', () => ({
  logAIActivity: vi.fn(),
}))

vi.mock('@/lib/error-notify', () => ({
  notifyError: vi.fn(),
}))

vi.mock('@/core/ai/cli-path', () => ({ getClaudeCliPath: () => '/usr/local/bin/claude' }))

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

import { aiQuery } from '@/core/ai/sdk'

interface CapturedOptions {
  model: string
  maxTurns: number
  persistSession?: boolean
  settingSources?: string[]
  thinking?: unknown
  maxThinkingTokens?: unknown
  pathToClaudeCodeExecutable?: string
  outputFormat?: { type: string; schema: unknown }
}

function capturedOptions(): CapturedOptions {
  return (mockQuery.mock.calls[0][0] as { options: CapturedOptions }).options
}

async function* successStream() {
  yield {
    type: 'result',
    subtype: 'success',
    result: '{"ok":true}',
    structured_output: { ok: true },
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockImplementation(() => successStream())
})

const base = {
  prompt: 'hello',
  model: 'claude-haiku-5-5',
  userId: 1,
  action: 'test',
  provider: 'sdk' as const,
}

describe('cold SDK query options', () => {
  test('runs the installed CLI with no session file and no settings', async () => {
    const result = await aiQuery({ ...base, outputSchema: { type: 'object', properties: {} } })

    expect(result.success).toBe(true)
    expect(result.structuredOutput).toEqual({ ok: true })
    const options = capturedOptions()
    expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(options.persistSession).toBe(false)
    expect(options.settingSources).toEqual([])
    expect(options.outputFormat?.type).toBe('json_schema')
    expect(options.thinking).toBeUndefined()
    expect(options.maxThinkingTokens).toBeUndefined()
  })

  test('a thinking budget is sent as a fixed budget, not the deprecated option', async () => {
    await aiQuery({ ...base, maxThinkingTokens: 10000 })

    const options = capturedOptions()
    expect(options.thinking).toEqual({ type: 'enabled', budgetTokens: 10000 })
    expect(options.maxThinkingTokens).toBeUndefined()
  })
})
