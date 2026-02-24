/**
 * Token hashing tests
 *
 * Verifies SHA-256 hashing of API tokens and preview extraction.
 */

import { describe, it, expect } from 'vitest'
import { hashToken, tokenPreview } from '@/core/auth/token-hash'

describe('token hashing', () => {
  it('produces a 64-char hex hash', () => {
    const hash = hashToken('a'.repeat(64))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    const token = 'abc123def456'
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('produces different hashes for different tokens', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'))
  })

  it('extracts last 8 chars as preview', () => {
    const token = 'abcdefghijklmnop12345678'
    expect(tokenPreview(token)).toBe('12345678')
  })
})
