/**
 * Tests for error-notify.ts — ntfy error alerting utility
 *
 * Verifies rate limiting, category mapping, configuration gating,
 * and fire-and-forget behavior.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Must stub env before importing the module
const originalEnv = { ...process.env }

describe('notifyError', () => {
  let notifyError: typeof import('@/lib/error-notify').notifyError
  let _resetRateLimits: typeof import('@/lib/error-notify')._resetRateLimits
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    fetchSpy = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetchSpy)
    process.env.OPENTASK_NTFY_TOPIC = 'test-errors'
    process.env.OPENTASK_NTFY_URL = 'https://ntfy.example.com'

    const mod = await import('@/lib/error-notify')
    notifyError = mod.notifyError
    _resetRateLimits = mod._resetRateLimits
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  test('sends notification when configured', () => {
    notifyError('server-error', 'GET /api/tasks 500', '120ms [session]')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://ntfy.example.com/test-errors')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Title).toBe('OpenTask: GET /api/tasks 500')
    expect(opts.headers.Priority).toBe('4')
    expect(opts.headers.Tags).toBe('rotating_light')
    expect(opts.body).toContain('[server-error]')
    expect(opts.body).toContain('120ms [session]')
  })

  test('does not send when OPENTASK_NTFY_TOPIC is empty', async () => {
    vi.resetModules()
    process.env.OPENTASK_NTFY_TOPIC = ''
    const mod = await import('@/lib/error-notify')

    mod.notifyError('server-error', 'test')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('does not send when OPENTASK_NTFY_TOPIC is unset', async () => {
    vi.resetModules()
    delete process.env.OPENTASK_NTFY_TOPIC
    const mod = await import('@/lib/error-notify')

    mod.notifyError('server-error', 'test')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rate-limits within the same category', () => {
    notifyError('cron-failure', 'first')
    notifyError('cron-failure', 'second')
    notifyError('cron-failure', 'third')

    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  test('different categories are rate-limited independently', () => {
    notifyError('server-error', 'server problem')
    notifyError('client-error', 'client problem')
    notifyError('cron-failure', 'cron problem')

    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test('sends again after rate limit window expires', () => {
    vi.useFakeTimers()

    notifyError('server-error', 'first')
    expect(fetchSpy).toHaveBeenCalledOnce()

    // Still within 5 min window
    vi.advanceTimersByTime(299_999)
    notifyError('server-error', 'second')
    expect(fetchSpy).toHaveBeenCalledOnce()

    // Past the 5 min window
    vi.advanceTimersByTime(1)
    notifyError('server-error', 'third')
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  test('maps priority correctly for each category', () => {
    const categories = [
      { cat: 'circuit-breaker' as const, priority: '5' },
      { cat: 'server-error' as const, priority: '4' },
      { cat: 'client-error' as const, priority: '4' },
      { cat: 'cron-failure' as const, priority: '4' },
      { cat: 'ai-failure' as const, priority: '3' },
      { cat: 'slot-failure' as const, priority: '3' },
    ]

    for (const { cat, priority } of categories) {
      notifyError(cat, 'test')
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
      expect(lastCall[1].headers.Priority).toBe(priority)
    }
  })

  test('uses message as body when no details provided', () => {
    notifyError('ai-failure', 'AI enrich failed')

    const body = fetchSpy.mock.calls[0][1].body
    expect(body).toBe('[ai-failure] AI enrich failed')
  })

  test('uses details as body when provided', () => {
    notifyError('ai-failure', 'AI enrich failed', 'Timeout after 60000ms')

    const body = fetchSpy.mock.calls[0][1].body
    expect(body).toBe('[ai-failure] Timeout after 60000ms')
  })

  test('swallows fetch errors silently', () => {
    fetchSpy.mockRejectedValue(new Error('network down'))

    // Should not throw
    expect(() => notifyError('server-error', 'test')).not.toThrow()
  })

  test('defaults to ntfy.sh when OPENTASK_NTFY_URL is unset', async () => {
    vi.resetModules()
    delete process.env.OPENTASK_NTFY_URL
    process.env.OPENTASK_NTFY_TOPIC = 'test-errors'
    const mod = await import('@/lib/error-notify')

    mod.notifyError('server-error', 'test')

    const url = fetchSpy.mock.calls[0][0]
    expect(url).toBe('https://ntfy.sh/test-errors')
  })

  test('_resetRateLimits clears all rate limit state', () => {
    notifyError('server-error', 'first')
    expect(fetchSpy).toHaveBeenCalledOnce()

    _resetRateLimits()

    notifyError('server-error', 'second')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
