/**
 * AI-NT: EVERY SDK QUERY RUNS WITH NO TOOLS (2026-11-09).
 *
 * The model reads untrusted text: titles from inbound email, shared content,
 * Shortcut input. Until 2026-11-09 the Claude Code CLI ran with every
 * built-in tool and `bypassPermissions`, so a title saying "run this" was a
 * prompt-injection path to Bash, Write, Edit and WebFetch on the server.
 * Nothing OpenTask asks for needs a tool; the answer comes back as
 * structured output or text. `NO_TOOLS` (src/core/ai/sdk-options.ts) is the
 * lockdown, and this pins that every entry point passes it: the cold query
 * (`aiQuery`, provider 'sdk') and the warm slots (enrichment, Quick Take),
 * which share warm-slot.ts's option builder.
 *
 * The SDK is mocked; the options are what OpenTask hands it, which the SDK
 * turns into CLI flags (`--disallowed-tools …`, `--permission-mode dontAsk`,
 * `--strict-mcp-config`). NOT `tools: []`: with an emptied tool set Sonnet 5.5
 * refuses the enrichment warmup every time (#459, reverted by #460), so the
 * tool set is narrowed by name and every call that needs permission is
 * denied — see sdk-options.ts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'test-model'
process.env.OPENTASK_AI_QUICKTAKE_SDK_MODEL = 'test-model'

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/core/ai/activity', () => ({ logAIActivity: vi.fn() }))
vi.mock('@/lib/error-notify', () => ({ notifyError: vi.fn() }))
vi.mock('@/core/ai/cli-path', () => ({ getClaudeCliPath: () => '/usr/local/bin/claude' }))

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

import { aiQuery } from '@/core/ai/sdk'
import {
  initEnrichmentSlot,
  shutdownEnrichmentSlot,
  _resetSlotForTesting as resetEnrichmentSlot,
} from '@/core/ai/enrichment-slot'
import {
  initQuickTakeSlot,
  shutdownQuickTakeSlot,
  _resetSlotForTesting as resetQuickTakeSlot,
} from '@/core/ai/quick-take-slot'

interface ToolOptions {
  tools?: unknown
  allowedTools?: unknown
  disallowedTools?: string[]
  permissionMode?: string
  allowDangerouslySkipPermissions?: boolean
  mcpServers?: unknown
  strictMcpConfig?: boolean
}

function optionsOfFirstCall(): ToolOptions {
  return (mockQuery.mock.calls[0][0] as { options: ToolOptions }).options
}

/** What every entry point must pass. */
function expectNoTools(options: ToolOptions): void {
  // An emptied tool set makes Sonnet refuse the warmup (sdk-options.ts).
  expect(options.tools).toBeUndefined()
  expect(options.allowedTools).toBeUndefined()
  expect(options.permissionMode).toBe('dontAsk')
  expect(options.allowDangerouslySkipPermissions).toBeUndefined()
  expect(options.disallowedTools).toEqual(
    expect.arrayContaining([
      'Bash',
      'Monitor',
      'Write',
      'Edit',
      'Read',
      'WebFetch',
      'WebSearch',
      'RemoteTrigger',
      'SendMessage',
      'Task',
      'Workflow',
      'CronCreate',
    ]),
  )
  expect(options.mcpServers).toEqual({})
  expect(options.strictMcpConfig).toBe(true)
}

/** A stream that never ends: the slot stays in warmup until shut down. */
function idleStream() {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {})
    },
    close: vi.fn(),
    interrupt: vi.fn(),
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

afterEach(() => {
  shutdownEnrichmentSlot()
  shutdownQuickTakeSlot()
  resetEnrichmentSlot()
  resetQuickTakeSlot()
})

describe('AI-NT01 no SDK query can reach a tool', () => {
  test('the cold query', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: '{}', structured_output: {} }
    })
    await aiQuery({
      prompt: 'hello',
      model: 'claude-haiku-5-5',
      userId: 1,
      action: 'test',
      provider: 'sdk',
      outputSchema: { type: 'object', properties: {} },
    })
    expectNoTools(optionsOfFirstCall())
  })

  test('the enrichment slot', async () => {
    mockQuery.mockImplementation(() => idleStream())
    void initEnrichmentSlot().catch(() => {})
    await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled())
    expectNoTools(optionsOfFirstCall())
  })

  test('the Quick Take slot', async () => {
    mockQuery.mockImplementation(() => idleStream())
    void initQuickTakeSlot().catch(() => {})
    await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled())
    expectNoTools(optionsOfFirstCall())
  })
})
