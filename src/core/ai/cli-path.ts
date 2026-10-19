/**
 * Which Claude Code CLI the Agent SDK spawns (SDK provider only — the
 * Anthropic and OpenAI providers never call this).
 *
 * Why this exists: the Agent SDK bundles its own CLI (0.2.37 bundled Claude
 * Code 2.1.37; 0.3 ships it as a per-platform optional package), and the SDK
 * runs that copy whenever it isn't handed a path. We spawn it with no settings
 * (`settingSources: []`, sdk-options.ts), and a CLI before 2.1.101 then
 * runs its background cleanup without the user's settings, so it ignores
 * `cleanupPeriodDays` and deletes every ~/.claude/projects transcript older
 * than 30 days. Upstream fixed this in 2.1.101 ("--setting-sources without
 * user causing background cleanup to ignore cleanupPeriodDays"). Dev
 * machines, evals, worktree agents and cloud boxes usually leave
 * OPENTASK_AI_CLI_PATH unset, so an AI call there would quietly wipe a month
 * of the machine's Claude Code history.
 *
 * So OpenTask NEVER runs the SDK's bundled CLI. Resolution, once per process
 * (cached), always yields an explicit path:
 *   1. OPENTASK_AI_CLI_PATH, when set. It is the operator's explicit choice,
 *      so PATH is not searched behind it — a deliberately dead path stays
 *      dead (scripts/screenshots/run.sh points it at a missing file so the
 *      warm slot can't spawn Claude Code).
 *   2. Otherwise the first `claude` on PATH (searched here, no shell).
 * No CLI found → ClaudeCliError ("Claude Code CLI not found ..."). A CLI whose
 * `--version` is below MIN_CLI_VERSION, or can't be read, is refused the same
 * way. (`--version` exits before any session or cleanup starts.) The error is
 * thrown on every SDK call, so the feature fails visibly (activity log, error
 * notification, a dead warm slot) instead of pruning transcripts silently.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log } from '@/lib/logger'

export const MIN_CLI_VERSION = '2.1.101'

const VERSION_PROBE_TIMEOUT_MS = 5000

export type CliSource = 'env' | 'path'

export interface CliCandidate {
  source: CliSource
  path: string
  /** Parsed version, or null when it couldn't be determined */
  version: string | null
  /** Why the version is null, for the log */
  versionError?: string
}

export type CliResolution =
  | { ok: true; cli: CliCandidate }
  /** No env path and no `claude` on PATH */
  | { ok: false; reason: 'not-found'; pathEnv: string | undefined }
  /** Found, but below the floor or its version is unknown */
  | { ok: false; reason: 'too-old'; cli: CliCandidate }

export interface CliResolverDeps {
  /** OPENTASK_AI_CLI_PATH */
  envPath: string | undefined
  /** The PATH variable to search */
  pathEnv: string | undefined
  platform: NodeJS.Platform
  /** True when `p` is an existing, executable regular file */
  isExecutable: (p: string) => boolean
  /** Runs `file args` and returns stdout; throws on failure */
  exec: (file: string, args: string[]) => string
}

/** The clear error SDK calls get when no usable CLI was found. */
export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeCliError'
  }
}

/** Pull `major.minor.patch` out of `claude --version` output ("2.1.303 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Numeric comparison of two `x.y.z` strings: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function meetsFloor(version: string | null): boolean {
  return version !== null && compareVersions(version, MIN_CLI_VERSION) >= 0
}

/** First `claude` executable on the given PATH, or undefined. */
export function findOnPath(deps: CliResolverDeps): string | undefined {
  if (!deps.pathEnv) return undefined
  const delimiter = deps.platform === 'win32' ? ';' : ':'
  const names = deps.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  for (const dir of deps.pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (deps.isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Probe a CLI's version. A `.js`/`.mjs`/`.cjs` path (the old documented form of
 * OPENTASK_AI_CLI_PATH, pointing at the CLI's cli.js) is run through node.
 */
function probeVersion(source: CliSource, cliPath: string, deps: CliResolverDeps): CliCandidate {
  const isScript = /\.(c|m)?js$/.test(cliPath)
  const file = isScript ? process.execPath : cliPath
  const args = isScript ? [cliPath, '--version'] : ['--version']
  try {
    const version = parseClaudeVersion(deps.exec(file, args))
    return version
      ? { source, path: cliPath, version }
      : { source, path: cliPath, version: null, versionError: 'unparseable --version output' }
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { source, path: cliPath, version: null, versionError: `--version failed: ${reason}` }
  }
}

/**
 * Pure resolver: the env path when set (PATH is not searched behind it), else
 * the first `claude` on PATH; then the version floor.
 */
export function resolveClaudeCli(deps: CliResolverDeps): CliResolution {
  let found: { source: CliSource; path: string } | null = null
  if (deps.envPath) {
    found = { source: 'env', path: deps.envPath }
  } else {
    const onPath = findOnPath(deps)
    if (onPath) found = { source: 'path', path: onPath }
  }
  if (!found) return { ok: false, reason: 'not-found', pathEnv: deps.pathEnv }
  const cli = probeVersion(found.source, found.path, deps)
  return meetsFloor(cli.version) ? { ok: true, cli } : { ok: false, reason: 'too-old', cli }
}

/** "path v1.2.3 (source)" — the shape the log lines use. */
export function describeCandidate(c: CliCandidate): string {
  const version = c.version ?? `unknown${c.versionError ? ` — ${c.versionError}` : ''}`
  return `${c.path} v${version} (${c.source})`
}

export const NOT_FOUND_MESSAGE =
  'Claude Code CLI not found: install Claude Code (https://docs.claude.com/en/docs/claude-code) ' +
  'or set OPENTASK_AI_PROVIDER=anthropic (or openai) to use an API provider.'

/** The error text for a failed resolution. */
export function refusalMessage(res: Exclude<CliResolution, { ok: true }>): string {
  if (res.reason === 'not-found') {
    return (
      `${NOT_FOUND_MESSAGE} OPENTASK_AI_CLI_PATH is unset and no \`claude\` was found on ` +
      `PATH (${res.pathEnv || 'empty'}). OpenTask never runs the Agent SDK's bundled CLI.`
    )
  }
  const how =
    res.cli.source === 'env' ? 'set by OPENTASK_AI_CLI_PATH' : 'the first `claude` on PATH'
  return (
    `Refusing to run Claude Code ${describeCandidate(res.cli)}, ${how}: SDK mode needs ` +
    `${MIN_CLI_VERSION} or newer. Older CLIs, spawned by the Agent SDK, ignore ` +
    `cleanupPeriodDays and delete ~/.claude/projects transcripts older than 30 days ` +
    `(fixed in ${MIN_CLI_VERSION}). Update Claude Code or point OPENTASK_AI_CLI_PATH at a ` +
    `current one.`
  )
}

// --- Real dependencies ---

function isExecutableFile(p: string): boolean {
  try {
    // statSync follows symlinks (~/.local/bin/claude is usually one)
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function execVersion(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: VERSION_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Same reason as the SDK spawn: a debugger bootloader in NODE_OPTIONS
    // makes the CLI crash.
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}

function defaultDeps(): CliResolverDeps {
  return {
    envPath: process.env.OPENTASK_AI_CLI_PATH || undefined,
    pathEnv: process.env.PATH,
    platform: process.platform,
    isExecutable: isExecutableFile,
    exec: execVersion,
  }
}

// --- Cached entry point ---

let cached: CliResolution | null = null
let logged = false

function logResolution(res: CliResolution): void {
  if (res.ok) {
    log.info('ai', `Claude CLI: ${res.cli.path} v${res.cli.version} (${res.cli.source})`)
  } else {
    log.error('ai', refusalMessage(res))
  }
}

/**
 * Resolve (once per process, cached) without logging or throwing — for
 * provider detection (`isSdkAvailable`), which decides whether SDK mode is
 * offered at all. A box with no usable CLI then simply has no SDK provider:
 * API providers are picked instead and no warm slot starts.
 */
export function probeClaudeCli(deps?: CliResolverDeps): CliResolution {
  if (!cached) cached = resolveClaudeCli(deps ?? defaultDeps())
  return cached
}

/**
 * The `pathToClaudeCodeExecutable` to pass the SDK — always a path, never the
 * bundled CLI. Logged once per process; throws ClaudeCliError on every call
 * when no usable CLI was found. Call it only on the SDK path.
 */
export function getClaudeCliPath(deps?: CliResolverDeps): string {
  const res = probeClaudeCli(deps)
  if (!logged) {
    logged = true
    logResolution(res)
  }
  if (!res.ok) throw new ClaudeCliError(refusalMessage(res))
  return res.cli.path
}

/** Test-only: forget the cached resolution. */
export function _resetClaudeCliForTesting(): void {
  cached = null
  logged = false
}
