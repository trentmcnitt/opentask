import { describe, test, expect } from 'vitest'
import { isChunkLoadError } from '@/lib/chunk-error'

describe('isChunkLoadError', () => {
  test('recognises the loaders’ chunk failures', () => {
    expect(
      isChunkLoadError(
        new Error(
          'Failed to load chunk /_next/static/chunks/c1eb57993e4b44e5.js from module 964893',
        ),
      ),
    ).toBe(true)
    expect(isChunkLoadError(new Error('Loading chunk 123 failed.'))).toBe(true)
    const named = new Error('x')
    named.name = 'ChunkLoadError'
    expect(isChunkLoadError(named)).toBe(true)
  })
  test('leaves every other error to the error page', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError('Failed to load chunk')).toBe(false)
  })
})
