/**
 * Global setup for integration tests
 *
 * 1. Builds Next.js with test env
 * 2. Starts production server on random port
 * 3. Seeds database
 * 4. Writes port to temp file for test helpers
 */

import { execSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

const ENV_FILE = path.join(process.cwd(), 'data', '.test-integration-env.json')
const DB_PATH = path.join(process.cwd(), 'data', 'test-integration.db')

const testEnv = {
  ...process.env,
  OPENTASK_DB_PATH: DB_PATH,
  OPENTASK_TEST_MODE: '1',
  OPENTASK_AI_PROVIDER: 'anthropic',
  AUTH_SECRET: 'test-secret-for-integration-tests',
}

declare global {
  var __TEST_SERVER__: ChildProcess | undefined
}

export async function setup() {
  // Clean up any previous test DB
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Build Next.js
  console.log('[integration] Building Next.js...')
  execSync('npx next build', {
    env: testEnv,
    stdio: 'pipe',
    cwd: process.cwd(),
  })

  // Start server on port 0 (random)
  console.log('[integration] Starting server...')
  const server = spawn('npx', ['next', 'start', '-p', '0'], {
    env: testEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })

  globalThis.__TEST_SERVER__ = server

  // Parse port from stdout
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timed out')), 60_000)

    let output = ''
    server.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      // Next.js prints: "  ▲ Next.js 16.x.x" then "  - Local: http://localhost:PORT"
      const match = output.match(/localhost:(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(parseInt(match[1]))
      }
    })

    server.stderr!.on('data', (chunk: Buffer) => {
      // Some warnings go to stderr, just collect them
      output += chunk.toString()
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    server.on('exit', (code) => {
      if (!output.includes('localhost:')) {
        clearTimeout(timeout)
        reject(new Error(`Server exited with code ${code}. Output: ${output}`))
      }
    })
  })

  console.log(`[integration] Server running on port ${port}`)

  // Wait for server to be ready
  const baseUrl = `http://localhost:${port}`
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/tasks`)
      // 401 means the server is up and processing requests
      if (res.status === 401 || res.status === 200) {
        ready = true
        break
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!ready) {
    throw new Error('Server never became ready')
  }

  // Seed the database
  console.log('[integration] Seeding database...')
  const seedRes = await fetch(`${baseUrl}/api/test/reset`, { method: 'POST' })
  if (!seedRes.ok) {
    const body = await seedRes.text()
    throw new Error(`Seed failed: ${seedRes.status} ${body}`)
  }

  // Write env file for test helpers
  fs.writeFileSync(ENV_FILE, JSON.stringify({ port }))
  console.log('[integration] Setup complete')
}

export async function teardown() {
  const server = globalThis.__TEST_SERVER__
  if (server) {
    server.kill('SIGTERM')
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 500))
    if (!server.killed) {
      server.kill('SIGKILL')
    }
  }

  // Clean up env file
  if (fs.existsSync(ENV_FILE)) {
    fs.unlinkSync(ENV_FILE)
  }

  console.log('[integration] Teardown complete')
}
