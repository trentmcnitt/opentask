/**
 * The open-stream registry that lets SIGTERM end every sync stream
 * (src/lib/sync-events.ts § OPEN STREAMS AND SHUTDOWN, 2026-10-26).
 * The end-to-end proof (a real server exits promptly with a stream held open)
 * is tests/integration/sync-stream-shutdown.test.ts. This pins the cases a
 * restart's timing makes hard to hit there: a stream that registers just after
 * shutdown began (seen on dev2: it held the process for 90 s), and a stream
 * that already ended.
 */
import { describe, test, expect } from 'vitest'
import { registerSyncStream, closeAllSyncStreams, isSyncShuttingDown } from '@/lib/sync-events'

describe('sync stream shutdown', () => {
  test('ends every open stream once, skips ended ones, then refuses and ends late ones', async () => {
    const closed: string[] = []
    registerSyncStream(() => closed.push('a'))
    const unregisterB = registerSyncStream(() => closed.push('b'))
    registerSyncStream(() => closed.push('c'))
    unregisterB() // b's client went away before the shutdown

    expect(isSyncShuttingDown()).toBe(false)
    expect(closeAllSyncStreams()).toBe(2)
    expect(closed.sort()).toEqual(['a', 'c'])
    expect(isSyncShuttingDown()).toBe(true)

    // Registered after closeAllSyncStreams ran: ended too, but not
    // synchronously, so the caller holds its unregister before close runs.
    let unregisterLate: (() => void) | null = null
    const late = () => {
      closed.push('late')
      expect(unregisterLate).not.toBeNull()
    }
    unregisterLate = registerSyncStream(late)
    expect(closed).not.toContain('late')
    await Promise.resolve()
    expect(closed).toContain('late')
  })
})
