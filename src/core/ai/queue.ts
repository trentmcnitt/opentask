/**
 * AI request queue / semaphore
 *
 * Limits concurrent SDK subprocesses to prevent resource exhaustion.
 * Interactive AI features (What's Next, triage, briefing) plus background
 * enrichment could spawn unbounded subprocesses without this guard.
 */

import { log } from '@/lib/logger'

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000 // 30 seconds max wait

interface QueueEntry {
  resolve: () => void
  reject: (error: Error) => void
  enqueuedAt: number
}

let activeConcurrent = 0
const waitQueue: QueueEntry[] = []

function getMaxConcurrent(): number {
  return parseInt(process.env.OPENTASK_AI_MAX_CONCURRENT || String(DEFAULT_MAX_CONCURRENT), 10)
}

function getQueueTimeout(): number {
  return parseInt(process.env.OPENTASK_AI_QUEUE_TIMEOUT_MS || String(DEFAULT_QUEUE_TIMEOUT_MS), 10)
}

/**
 * Acquire a slot in the semaphore. Resolves when a slot is available.
 * Rejects if the queue timeout is exceeded.
 */
export function acquireSlot(): Promise<void> {
  if (activeConcurrent < getMaxConcurrent()) {
    activeConcurrent++
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = { resolve, reject, enqueuedAt: Date.now() }
    waitQueue.push(entry)

    const timeout = getQueueTimeout()
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry)
      if (idx !== -1) {
        waitQueue.splice(idx, 1)
        reject(new Error(`AI queue timeout: waited ${timeout}ms for available slot`))
        log.warn('ai', `Queue timeout after ${timeout}ms (${waitQueue.length} still waiting)`)
      }
    }, timeout)

    // Store timer ref so we can clear it on resolve
    const originalResolve = entry.resolve
    entry.resolve = () => {
      clearTimeout(timer)
      originalResolve()
    }
  })
}

/**
 * Release a slot in the semaphore. Must be called in a finally block
 * after acquireSlot() to prevent deadlocks.
 */
export function releaseSlot(): void {
  activeConcurrent--

  // Wake the next waiter, if any
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!
    activeConcurrent++
    next.resolve()
  }
}

/**
 * Run a function with a semaphore slot. Automatically acquires before
 * and releases after (even on error).
 */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    return await fn()
  } finally {
    releaseSlot()
  }
}

/** Get current queue stats (for debugging/monitoring) */
export function getQueueStats(): { active: number; waiting: number; maxConcurrent: number } {
  return {
    active: activeConcurrent,
    waiting: waitQueue.length,
    maxConcurrent: getMaxConcurrent(),
  }
}

/** Reset queue state (for testing) */
export function _resetQueue(): void {
  activeConcurrent = 0
  waitQueue.length = 0
}
