/**
 * Behavioral tests for AI request queue / semaphore
 *
 * Tests slot acquisition, release, queuing, timeout, and withSlot wrapper.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { acquireSlot, releaseSlot, withSlot, getQueueStats, _resetQueue } from '@/core/ai/queue'

afterEach(() => {
  _resetQueue()
})

describe('semaphore', () => {
  test('acquires slots up to the limit', async () => {
    await acquireSlot()
    await acquireSlot()

    const stats = getQueueStats()
    expect(stats.active).toBe(2)
    expect(stats.waiting).toBe(0)

    releaseSlot()
    releaseSlot()

    const after = getQueueStats()
    expect(after.active).toBe(0)
  })

  test('queues requests beyond the limit', async () => {
    // Fill both slots
    await acquireSlot()
    await acquireSlot()

    // Third request should be queued
    let resolved = false
    const thirdSlot = acquireSlot().then(() => {
      resolved = true
    })

    // Give the event loop a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
    expect(getQueueStats().waiting).toBe(1)

    // Release one slot — the queued request should resolve
    releaseSlot()
    await thirdSlot
    expect(resolved).toBe(true)

    releaseSlot()
    releaseSlot()
  })

  test('withSlot releases on success', async () => {
    const result = await withSlot(async () => {
      expect(getQueueStats().active).toBe(1)
      return 42
    })

    expect(result).toBe(42)
    expect(getQueueStats().active).toBe(0)
  })

  test('withSlot releases on error', async () => {
    await expect(
      withSlot(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(getQueueStats().active).toBe(0)
  })

  test('getQueueStats returns correct values', () => {
    const stats = getQueueStats()
    expect(stats.active).toBe(0)
    expect(stats.waiting).toBe(0)
    expect(stats.maxConcurrent).toBe(2) // default
  })
})
