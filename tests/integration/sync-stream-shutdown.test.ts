/**
 * SIGTERM with a sync stream open (2026-10-26).
 *
 * Next's standalone server answers SIGTERM with `server.close()`, which waits
 * for every open connection to end, and an SSE response never ends on its
 * own. Before the fix, one open tab kept the old process alive until
 * systemd's 90 s stop timeout killed it: prod 502'd for 90 s on every deploy
 * with a client connected (src/lib/sync-events.ts § OPEN STREAMS AND
 * SHUTDOWN).
 *
 * This file starts its OWN server from the build globalSetup made, on its own
 * port and database, since it has to kill it. It runs `next` with node
 * directly, not through npx, so the SIGTERM reaches the server itself. Then
 * it holds `/api/sync/stream` open, sends SIGTERM, and checks that the stream
 * ends and the process exits 0 promptly. Without the fix it never exits on
 * its own, and `exitWithin` fails.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { TOKEN_A } from './helpers'

const DB_PATH = path.join(process.cwd(), 'data', 'test-integration-shutdown.db')
const NEXT_BIN = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next')

/**
 * How long a clean shutdown may take. A clean exit is milliseconds. The two
 * failures this catches: the stream never ending (no exit until systemd's 90 s
 * timeout), and the ended stream's keep-alive socket holding close() for Node's
 * keep-alive timeout (~5 s).
 */
const PROMPT_EXIT_MS = 2_000

let server: ChildProcess
let base = ''
let output = ''

function removeDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
}

/** Resolves with the exit code, or rejects if the process is still running after `ms`. */
function exitWithin(proc: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode)
    const timer = setTimeout(
      () => reject(new Error(`server still running ${ms} ms after SIGTERM. Output:\n${output}`)),
      ms,
    )
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

beforeAll(async () => {
  removeDb()
  server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', '0'], {
    env: {
      ...process.env,
      OPENTASK_DB_PATH: DB_PATH,
      OPENTASK_TEST_MODE: '1',
      AUTH_SECRET: 'test-secret-for-integration-tests',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })
  server.stdout!.on('data', (c: Buffer) => (output += c.toString()))
  server.stderr!.on('data', (c: Buffer) => (output += c.toString()))

  const port = await new Promise<number>((resolve, reject) => {
    const onData = () => {
      const m = output.match(/localhost:(\d+)/)
      if (m) resolve(parseInt(m[1]))
    }
    server.stdout!.on('data', onData)
    server.once('exit', (code) => reject(new Error(`server exited (${code}): ${output}`)))
  })
  base = `http://localhost:${port}`

  // Ready once it answers; then seed, which creates TOKEN_A's user.
  for (;;) {
    const res = await fetch(`${base}/api/tasks`).catch(() => null)
    if (res) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const seed = await fetch(`${base}/api/test/reset`, { method: 'POST' })
  expect(seed.ok).toBe(true)
}, 60_000)

afterAll(() => {
  if (server.exitCode === null) server.kill('SIGKILL')
  removeDb()
})

describe('SIGTERM with a sync stream open', () => {
  test('the stream ends and the server exits 0 promptly', async () => {
    const res = await fetch(`${base}/api/sync/stream`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"type":"connected"')

    // The rest of the stream: it must END (done), not hang, once SIGTERM lands.
    const rest = (async () => {
      for (;;) {
        const { done } = await reader.read().catch(() => ({ done: true }))
        if (done) return
      }
    })()

    const started = Date.now()
    server.kill('SIGTERM')
    const code = await exitWithin(server, PROMPT_EXIT_MS)
    await rest

    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(PROMPT_EXIT_MS)
  }, 30_000)
})
