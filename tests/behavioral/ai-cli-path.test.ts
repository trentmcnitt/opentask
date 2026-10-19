/**
 * Claude CLI resolution (src/core/ai/cli-path.ts)
 *
 * The SDK provider runs only an installed Claude Code CLI (OPENTASK_AI_CLI_PATH,
 * else the first `claude` on PATH), never the Agent SDK's bundled copy, and
 * never one older than 2.1.101: those ignore cleanupPeriodDays when spawned
 * without settingSources and delete ~/.claude/projects transcripts older than
 * 30 days. These tests drive the resolver with injected PATH, env and exec —
 * nothing here runs a real CLI.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveClaudeCli,
  getClaudeCliPath,
  parseClaudeVersion,
  compareVersions,
  ClaudeCliError,
  _resetClaudeCliForTesting,
  probeClaudeCli,
  type CliResolverDeps,
} from '@/core/ai/cli-path'
import { log } from '@/lib/logger'

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}))

/** Build deps: `bins` maps executable path → its `--version` output (or an Error to throw). */
function makeDeps(opts: {
  envPath?: string
  pathEnv?: string
  bins?: Record<string, string | Error>
}): CliResolverDeps & { exec: ReturnType<typeof vi.fn> } {
  const bins = opts.bins ?? {}
  const exec = vi.fn((file: string) => {
    const out = bins[file]
    if (out === undefined) throw new Error(`spawn ${file} ENOENT`)
    if (out instanceof Error) throw out
    return out
  })
  return {
    envPath: opts.envPath,
    pathEnv: opts.pathEnv,
    platform: 'darwin',
    isExecutable: (p) => p in bins,
    exec,
  }
}

function errorMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ClaudeCliError)
    return (err as Error).message
  }
  throw new Error('expected a throw')
}

describe('parseClaudeVersion', () => {
  test('parses the real --version output', () => {
    expect(parseClaudeVersion('2.1.303 (Claude Code)')).toBe('2.1.303')
    expect(parseClaudeVersion('2.1.37\n')).toBe('2.1.37')
  })

  test('returns null for output with no version', () => {
    expect(parseClaudeVersion('command not found')).toBeNull()
  })

  test('compares numerically, not as strings', () => {
    expect(compareVersions('2.1.303', '2.1.101')).toBeGreaterThan(0)
    expect(compareVersions('2.1.37', '2.1.101')).toBeLessThan(0)
    expect(compareVersions('2.1.101', '2.1.101')).toBe(0)
    expect(compareVersions('3.0.0', '2.1.999')).toBeGreaterThan(0)
  })
})

describe('resolveClaudeCli', () => {
  test('OPENTASK_AI_CLI_PATH wins over a claude on PATH', () => {
    const deps = makeDeps({
      envPath: '/opt/claude/bin/claude',
      pathEnv: '/usr/local/bin',
      bins: {
        '/opt/claude/bin/claude': '2.1.200 (Claude Code)',
        '/usr/local/bin/claude': '2.1.303 (Claude Code)',
      },
    })
    expect(resolveClaudeCli(deps)).toEqual({
      ok: true,
      cli: { source: 'env', path: '/opt/claude/bin/claude', version: '2.1.200' },
    })
    expect(deps.exec).toHaveBeenCalledTimes(1)
  })

  test('a set env path that fails does not fall through to PATH', () => {
    // scripts/screenshots/run.sh relies on this: a dead env path keeps Claude
    // Code from spawning even when `claude` is installed.
    const deps = makeDeps({
      envPath: '/nonexistent/claude-code',
      pathEnv: '/usr/local/bin',
      bins: { '/usr/local/bin/claude': '2.1.303 (Claude Code)' },
    })
    const res = resolveClaudeCli(deps)
    expect(res).toMatchObject({
      ok: false,
      reason: 'too-old',
      cli: { source: 'env', version: null },
    })
    expect(deps.exec).toHaveBeenCalledTimes(1)
    expect(deps.exec).not.toHaveBeenCalledWith('/usr/local/bin/claude', expect.anything())
  })

  test('an env path to cli.js is probed through node', () => {
    const deps = makeDeps({ envPath: '/opt/cc/cli.js' })
    deps.exec.mockImplementation((file: string, args: string[]) => {
      expect(file).toBe(process.execPath)
      expect(args).toEqual(['/opt/cc/cli.js', '--version'])
      return '2.1.150 (Claude Code)'
    })
    expect(resolveClaudeCli(deps)).toMatchObject({ ok: true, cli: { path: '/opt/cc/cli.js' } })
  })

  test('finds the first claude on PATH, skipping empty entries', () => {
    const deps = makeDeps({
      pathEnv: '::/usr/bin:/home/u/.local/bin:/usr/local/bin',
      bins: {
        '/home/u/.local/bin/claude': '2.1.303 (Claude Code)',
        '/usr/local/bin/claude': '2.1.250 (Claude Code)',
      },
    })
    expect(resolveClaudeCli(deps)).toEqual({
      ok: true,
      cli: { source: 'path', path: '/home/u/.local/bin/claude', version: '2.1.303' },
    })
  })

  test('no env path and no claude on PATH is not-found (never the bundled CLI)', () => {
    const deps = makeDeps({ pathEnv: '/usr/bin:/bin' })
    expect(resolveClaudeCli(deps)).toEqual({
      ok: false,
      reason: 'not-found',
      pathEnv: '/usr/bin:/bin',
    })
    expect(deps.exec).not.toHaveBeenCalled()
  })

  test('a claude on PATH below 2.1.101 is refused', () => {
    const deps = makeDeps({
      pathEnv: '/usr/local/bin',
      bins: { '/usr/local/bin/claude': '2.1.90 (Claude Code)' },
    })
    expect(resolveClaudeCli(deps)).toEqual({
      ok: false,
      reason: 'too-old',
      cli: { source: 'path', path: '/usr/local/bin/claude', version: '2.1.90' },
    })
  })

  test('a CLI whose version cannot be read is refused', () => {
    const failing = makeDeps({
      pathEnv: '/usr/local/bin',
      bins: { '/usr/local/bin/claude': new Error('timed out') },
    })
    expect(resolveClaudeCli(failing)).toMatchObject({
      ok: false,
      reason: 'too-old',
      cli: { version: null, versionError: '--version failed: timed out' },
    })

    const garbled = makeDeps({
      pathEnv: '/usr/local/bin',
      bins: { '/usr/local/bin/claude': 'Claude Code' },
    })
    expect(resolveClaudeCli(garbled)).toMatchObject({ ok: false, cli: { version: null } })
  })
})

describe('getClaudeCliPath', () => {
  beforeEach(() => _resetClaudeCliForTesting())
  afterEach(() => _resetClaudeCliForTesting())

  test('resolves once per process and returns the cached path', () => {
    const deps = makeDeps({
      pathEnv: '/home/u/.local/bin',
      bins: { '/home/u/.local/bin/claude': '2.1.303 (Claude Code)' },
    })
    expect(getClaudeCliPath(deps)).toBe('/home/u/.local/bin/claude')
    expect(getClaudeCliPath(deps)).toBe('/home/u/.local/bin/claude')
    expect(deps.exec).toHaveBeenCalledTimes(1)
  })

  test('none found throws the not-found error naming the env var and the PATH searched', () => {
    const deps = makeDeps({ pathEnv: '/usr/bin:/bin' })
    const message = errorMessage(() => getClaudeCliPath(deps))
    expect(message).toContain(
      'Claude Code CLI not found: install Claude Code (https://docs.claude.com/en/docs/claude-code) ' +
        'or set OPENTASK_AI_PROVIDER=anthropic (or openai) to use an API provider.',
    )
    expect(message).toContain('OPENTASK_AI_CLI_PATH')
    expect(message).toContain('/usr/bin:/bin')
  })

  test('too old throws, naming the path, version, floor and why; the refusal is cached', () => {
    const deps = makeDeps({
      pathEnv: '/usr/local/bin',
      bins: { '/usr/local/bin/claude': '2.1.90 (Claude Code)' },
    })
    const message = errorMessage(() => getClaudeCliPath(deps))
    expect(message).toContain('/usr/local/bin/claude v2.1.90 (path)')
    expect(message).toContain('2.1.101')
    expect(message).toContain('cleanupPeriodDays')
    expect(errorMessage(() => getClaudeCliPath(deps))).toBe(message)
    expect(deps.exec).toHaveBeenCalledTimes(1)
  })
})

// --- API providers never touch the CLI ---

const cliSpy = vi.hoisted(() => vi.fn(() => '/usr/local/bin/claude'))
// Provider detection may PROBE for an installed CLI (`claude --version` only, no
// session) to decide whether SDK mode is offered; it never resolves it for use.
const probeSpy = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    cli: { source: 'path', path: '/usr/local/bin/claude', version: '2.1.303' },
  })),
)

describe('API providers never run the CLI', () => {
  beforeEach(() => {
    cliSpy.mockClear()
    vi.resetModules()
    vi.doMock('@/core/ai/cli-path', () => ({
      getClaudeCliPath: cliSpy,
      probeClaudeCli: probeSpy,
      refusalMessage: () => 'unavailable',
    }))
    vi.doMock('@/core/ai/api-provider', () => ({
      apiQuery: vi.fn(async () => ({ success: true })),
    }))
    vi.doMock('@/core/ai/openai-provider', () => ({
      openaiQuery: vi.fn(async () => ({ success: true })),
    }))
  })

  afterEach(() => {
    vi.doUnmock('@/core/ai/cli-path')
    vi.doUnmock('@/core/ai/api-provider')
    vi.doUnmock('@/core/ai/openai-provider')
    vi.unstubAllEnvs()
  })

  test.each(['anthropic', 'openai'] as const)('aiQuery with provider %s', async (provider) => {
    const { aiQuery } = await import('@/core/ai/sdk')
    await aiQuery({ prompt: 'hi', model: 'sonnet', userId: 1, action: 'test', provider })
    expect(cliSpy).not.toHaveBeenCalled()
  })

  test('initAI with an API default provider', async () => {
    vi.stubEnv('OPENTASK_AI_ENABLED', 'true')
    vi.stubEnv('OPENTASK_AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    const { initAI } = await import('@/core/ai/sdk')
    await initAI()
    expect(cliSpy).not.toHaveBeenCalled()
  })

  test('initAI in SDK mode does resolve it (the boot-time check)', async () => {
    vi.stubEnv('OPENTASK_AI_ENABLED', 'true')
    vi.stubEnv('OPENTASK_AI_PROVIDER', 'sdk')
    const { initAI } = await import('@/core/ai/sdk')
    await initAI()
    expect(cliSpy).toHaveBeenCalledTimes(1)
  })
})

describe('probeClaudeCli and SDK availability', () => {
  beforeEach(() => _resetClaudeCliForTesting())

  test('probe resolves and caches without logging; the first getClaudeCliPath logs once', async () => {
    vi.mocked(log.info).mockClear()
    vi.mocked(log.error).mockClear()
    const deps = makeDeps({
      pathEnv: '/usr/bin',
      bins: { '/usr/bin/claude': '2.1.303 (Claude Code)' },
    })
    expect(probeClaudeCli(deps).ok).toBe(true)
    expect(log.info).not.toHaveBeenCalled()
    expect(getClaudeCliPath(deps)).toBe('/usr/bin/claude')
    getClaudeCliPath(deps)
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(deps.exec).toHaveBeenCalledTimes(1)
  })

  test('no usable CLI → the SDK provider is unavailable, with the not-found reason', async () => {
    vi.resetModules()
    vi.doMock('@/core/ai/cli-path', async (orig) => {
      const real = await orig<typeof import('@/core/ai/cli-path')>()
      return {
        ...real,
        probeClaudeCli: () => ({ ok: false, reason: 'not-found', pathEnv: '/nowhere' }),
      }
    })
    const provider = await import('@/core/ai/provider')
    expect(await provider.isSdkAvailable()).toBe(false)
    expect(provider.sdkUnavailableReason()).toMatch(/Claude Code CLI not found/)
    vi.doUnmock('@/core/ai/cli-path')
    vi.resetModules()
  })
})
