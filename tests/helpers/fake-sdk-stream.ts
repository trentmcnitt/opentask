/**
 * Controllable fake SDK stream for warm slot tests.
 *
 * Mimics the AsyncGenerator<SDKMessage, void> returned by the Claude Agent
 * SDK's query(). Tests push messages into it via emit(), and the slot's
 * consumeStream() pulls them out via iteration.
 */

export interface FakeStreamControl {
  /** The async generator returned by the mock query() */
  stream: AsyncGenerator<unknown, void>
  /** Push an SDK message into the stream (consumer will receive it) */
  emit(message: unknown): void
  /** Signal the stream is done (iterator returns) */
  end(): void
  /** Throw an error in the stream (consumer sees rejection) */
  error(err: Error): void
  /** Whether return() was called on the iterator (cleanup verification) */
  returnCalled: boolean
  /** Whether the slot called close() on the query (it kills the real subprocess) */
  closeCalled: boolean
}

export function createFakeStream(): FakeStreamControl {
  let resolve: ((result: IteratorResult<unknown>) => void) | null = null
  let reject: ((err: Error) => void) | null = null
  let done = false
  const pending: Array<{ type: 'value'; value: unknown } | { type: 'error'; error: Error }> = []
  let _returnCalled = false
  let _closeCalled = false

  /** End the stream: a pending next() resolves done, later ones too. */
  function finish(): void {
    done = true
    if (resolve) {
      const r = resolve
      resolve = null
      reject = null
      r({ value: undefined as unknown, done: true })
    }
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return this
    },

    next(): Promise<IteratorResult<unknown>> {
      if (pending.length > 0) {
        const item = pending.shift()!
        if (item.type === 'error') {
          return Promise.reject(item.error)
        }
        return Promise.resolve({ value: item.value, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined as unknown, done: true })
      }
      return new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
    },

    return(): Promise<IteratorResult<unknown>> {
      _returnCalled = true
      finish()
      return Promise.resolve({ value: undefined as unknown, done: true })
    },

    throw(err: unknown): Promise<IteratorResult<unknown>> {
      done = true
      if (reject) {
        const r = reject
        resolve = null
        reject = null
        r(err instanceof Error ? err : new Error(String(err)))
      }
      return Promise.reject(err)
    },
  } as AsyncGenerator<unknown, void>

  // Like the SDK's Query.close(): terminates the subprocess, so no further
  // messages arrive and the iterator ends.
  Object.assign(stream, {
    close(): void {
      _closeCalled = true
      pending.length = 0
      finish()
    },
  })

  return {
    stream,
    get returnCalled() {
      return _returnCalled
    },
    get closeCalled() {
      return _closeCalled
    },

    emit(message: unknown) {
      if (done) return
      if (resolve) {
        const r = resolve
        resolve = null
        reject = null
        r({ value: message, done: false })
      } else {
        pending.push({ type: 'value', value: message })
      }
    },

    end() {
      finish()
    },

    error(err: Error) {
      if (resolve) {
        const r = reject!
        resolve = null
        reject = null
        r(err)
      } else {
        pending.push({ type: 'error', error: err })
      }
    },
  }
}

/** Build a success result message matching SDK shape */
export function makeSuccessResult(
  text: string,
  structuredOutput?: unknown,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    structured_output: structuredOutput,
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'test',
  }
}

/** Build an error result message */
export function makeErrorResult(
  subtype: string = 'error_during_execution',
): Record<string, unknown> {
  return {
    type: 'result',
    subtype,
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ['Something went wrong'],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'test',
  }
}
