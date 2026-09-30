import { describe, expect, it } from 'vitest'
import { nextFocusAfterRemoval } from '@/lib/keyboard-nav'

describe('nextFocusAfterRemoval', () => {
  const ids = [10, 20, 30, 40]

  it('moves forward to the next row first', () => {
    expect(nextFocusAfterRemoval(ids, 20)).toBe(30)
  })

  it('falls back to the previous row at the end of the list', () => {
    expect(nextFocusAfterRemoval(ids, 40)).toBe(30)
  })

  it('skips every row in the removed set, both ways', () => {
    expect(nextFocusAfterRemoval(ids, 20, new Set([20, 30]))).toBe(40)
    expect(nextFocusAfterRemoval(ids, 30, new Set([30, 40, 20]))).toBe(10)
  })

  it('returns null when nothing would be left', () => {
    expect(nextFocusAfterRemoval([10], 10)).toBeNull()
    expect(nextFocusAfterRemoval(ids, 10, new Set(ids))).toBeNull()
  })

  it('returns null when the focused row is not in the list', () => {
    expect(nextFocusAfterRemoval(ids, 99)).toBeNull()
  })
})
