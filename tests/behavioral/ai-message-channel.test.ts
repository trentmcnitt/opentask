/**
 * MessageChannel behavioral tests
 *
 * Tests the async iterable message channel used by warm slots to communicate
 * with the Claude Agent SDK subprocess. This is the foundation both the
 * enrichment slot and quick take slot are built on.
 *
 * No mocking needed — pure async logic with no external dependencies.
 */

import { describe, test, expect } from 'vitest'
import { createMessageChannel } from '@/core/ai/message-channel'

/** Helper: race a promise against a short timer to check if it's pending */
async function isPending(promise: Promise<unknown>, ms = 50): Promise<boolean> {
  const sentinel = Symbol('pending')
  const result = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(sentinel), ms)),
  ])
  return result === sentinel
}

describe('createMessageChannel', () => {
  describe('push/pull synchronization', () => {
    test('push before pull: buffered message is immediately available', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.push('hello')
      const result = await iter.next()

      expect(result.done).toBe(false)
      expect(result.value.message.content).toBe('hello')
    })

    test('pull before push: consumer waits until message arrives', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      const pullPromise = iter.next()
      expect(await isPending(pullPromise)).toBe(true)

      channel.push('delayed')
      const result = await pullPromise

      expect(result.done).toBe(false)
      expect(result.value.message.content).toBe('delayed')
    })

    test('message format: push wraps string in SdkUserMessage structure', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.push('test content')
      const { value } = await iter.next()

      expect(value.type).toBe('user')
      expect(value.message.role).toBe('user')
      expect(value.message.content).toBe('test content')
      expect(value.parent_tool_use_id).toBeNull()
      expect(value.session_id).toBe('')
    })
  })

  describe('buffering', () => {
    test('buffers multiple messages in FIFO order', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.push('first')
      channel.push('second')
      channel.push('third')

      const r1 = await iter.next()
      const r2 = await iter.next()
      const r3 = await iter.next()

      expect(r1.value.message.content).toBe('first')
      expect(r2.value.message.content).toBe('second')
      expect(r3.value.message.content).toBe('third')

      // Fourth pull should block (nothing buffered)
      const fourthPromise = iter.next()
      expect(await isPending(fourthPromise)).toBe(true)

      // Unblock it
      channel.push('fourth')
      const r4 = await fourthPromise
      expect(r4.value.message.content).toBe('fourth')
    })

    test('alternating push/pull works correctly', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.push('a')
      expect((await iter.next()).value.message.content).toBe('a')

      channel.push('b')
      expect((await iter.next()).value.message.content).toBe('b')

      channel.push('c')
      expect((await iter.next()).value.message.content).toBe('c')
    })
  })

  describe('close behavior', () => {
    test('close resolves pending pull with done: true', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      const pullPromise = iter.next()
      expect(await isPending(pullPromise)).toBe(true)

      channel.close()
      const result = await pullPromise
      expect(result.done).toBe(true)
    })

    test('close then push is a no-op', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.close()
      channel.push('ignored')

      const result = await iter.next()
      expect(result.done).toBe(true)
    })

    test('close clears pending buffer', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      channel.push('buffered1')
      channel.push('buffered2')
      channel.close()

      // After close, pending messages are cleared
      const result = await iter.next()
      expect(result.done).toBe(true)
    })

    test('multiple close calls are idempotent', () => {
      const channel = createMessageChannel()

      channel.close()
      channel.close()
      channel.close()
      // Should not throw
    })
  })

  describe('iterator return()', () => {
    test('return() signals done and resolves pending consumer', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      // Start a pending pull
      const pullPromise = iter.next()
      expect(await isPending(pullPromise)).toBe(true)

      // return() should resolve the pending pull with done: true
      await iter.return!(undefined as unknown)
      const result = await pullPromise
      expect(result.done).toBe(true)

      // Subsequent next() also returns done
      const next = await iter.next()
      expect(next.done).toBe(true)
    })

    test('return() without pending consumer still signals done', async () => {
      const channel = createMessageChannel()
      const iter = channel.iterable[Symbol.asyncIterator]()

      await iter.return!(undefined as unknown)

      const result = await iter.next()
      expect(result.done).toBe(true)
    })
  })
})
