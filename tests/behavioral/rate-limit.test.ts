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
})
