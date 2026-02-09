/**
 * Async iterable message channel for SDK subprocess communication.
 *
 * Adapted from bespoke-ai-vscode-ext/src/utils/message-channel.ts.
 * Buffers messages and yields them when the SDK calls next().
 * Used by the enrichment slot to keep a subprocess warm and reuse it
 * across requests via the SDK's MessageChannel pattern.
 */

/** SDK user message structure for type safety. */
export interface SdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  session_id: string
}

export interface MessageChannel {
  iterable: AsyncIterable<SdkUserMessage>
  push(message: string): void
  close(): void
}

export function createMessageChannel(): MessageChannel {
  let resolve: ((value: IteratorResult<SdkUserMessage>) => void) | null = null
  let done = false
  const pending: SdkUserMessage[] = []

  const iterable: AsyncIterable<SdkUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SdkUserMessage>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SdkUserMessage, done: true })
          }
          return new Promise((r) => {
            resolve = r
          })
        },
        return(): Promise<IteratorResult<SdkUserMessage>> {
          done = true
          if (resolve) {
            resolve({ value: undefined as unknown as SdkUserMessage, done: true })
            resolve = null
          }
          return Promise.resolve({ value: undefined as unknown as SdkUserMessage, done: true })
        },
      }
    },
  }

  return {
    iterable,
    push(message: string) {
      if (done) return
      const msg: SdkUserMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: message },
        parent_tool_use_id: null,
        session_id: '',
      }
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value: msg, done: false })
      } else {
        pending.push(msg)
      }
    },
    close() {
      done = true
      pending.length = 0
      if (resolve) {
        resolve({ value: undefined as unknown as SdkUserMessage, done: true })
        resolve = null
      }
    },
  }
}
