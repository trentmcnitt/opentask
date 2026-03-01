/**
 * Login rate limiting tests
 *
 * Verifies the in-memory rate limiter blocks after 5 failures and uses exponential backoff.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
  resetRateLimits,
} from '@/core/auth/rate-limit'

describe('login rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    resetRateLimits()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows first attempt', () => {
    expect(checkRateLimit('testuser')).toBeNull()
  })

  it('allows up to 4 failed attempts', () => {
    for (let i = 0; i < 4; i++) {
      recordFailedAttempt('testuser')
    }
    expect(checkRateLimit('testuser')).toBeNull()
  })

  it('blocks after 5 failed attempts', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('testuser')
    }
    const wait = checkRateLimit('testuser')
    expect(wait).not.toBeNull()
    expect(wait!).toBeGreaterThan(0)
    expect(wait!).toBeLessThanOrEqual(30) // 30 seconds initial backoff
  })

  it('uses exponential backoff for continued attempts', () => {
    // 5 failures to trigger lockout
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('testuser')
    }

    // Wait past first backoff (30s) and record another failure
    vi.advanceTimersByTime(31_000)
    expect(checkRateLimit('testuser')).toBeNull() // unlocked after backoff
    recordFailedAttempt('testuser') // 6th attempt

    const wait = checkRateLimit('testuser')
    expect(wait).not.toBeNull()
    expect(wait!).toBeGreaterThan(30) // 60s backoff now
    expect(wait!).toBeLessThanOrEqual(60)
  })

  it('is case-insensitive', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('TestUser')
    }
    expect(checkRateLimit('testuser')).not.toBeNull()
  })

  it('clears attempts on successful login', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('testuser')
    }
    expect(checkRateLimit('testuser')).not.toBeNull()

    clearAttempts('testuser')
    expect(checkRateLimit('testuser')).toBeNull()
  })

  it('resets after 15-minute window expires', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('testuser')
    }
    expect(checkRateLimit('testuser')).not.toBeNull()

    // Advance past the 15-minute window
    vi.advanceTimersByTime(16 * 60 * 1000)
    expect(checkRateLimit('testuser')).toBeNull()
  })

  it('tracks users independently', () => {
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('user-a')
    }
    expect(checkRateLimit('user-a')).not.toBeNull()
    expect(checkRateLimit('user-b')).toBeNull()
  })

  it('window boundary: new failure at T=14:59 triggers lockout, window expiry at T=15:01 resets', () => {
    // 5 failures at T=0 — triggers lockout with 30s backoff
    for (let i = 0; i < 5; i++) {
      recordFailedAttempt('boundary-user')
    }
    expect(checkRateLimit('boundary-user')).not.toBeNull()

    // Advance to T=14:59 — backoff (30s) expired long ago, but still within 15-min window
    vi.advanceTimersByTime(14 * 60 * 1000 + 59 * 1000)
    expect(checkRateLimit('boundary-user')).toBeNull() // backoff expired

    // 6th failure at T=14:59 — count still tracked (window hasn't expired)
    recordFailedAttempt('boundary-user')
    expect(checkRateLimit('boundary-user')).not.toBeNull() // locked again (60s backoff)

    // Advance 2 seconds to T=15:01 — window expires, all counts reset
    vi.advanceTimersByTime(2 * 1000)
    expect(checkRateLimit('boundary-user')).toBeNull()
  })

  it('backoff overflow safety: 100 failed attempts does not crash', () => {
    for (let i = 0; i < 100; i++) {
      recordFailedAttempt('overflow-user')
    }
    // Should not throw — backoff calculation may produce Infinity but checkRateLimit handles it
    const wait = checkRateLimit('overflow-user')
    expect(wait).not.toBeNull()
    // The wait value may be very large or Infinity-derived, but it should be a number
    expect(typeof wait).toBe('number')
  })
})
