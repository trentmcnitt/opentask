/**
 * savePreference — the one optimistic save every Settings control uses:
 * apply, PATCH /api/user/preferences, toast, revert on failure.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/lib/toast', () => ({ showToast: toast }))

import { savePreference } from '@/lib/save-preference'

const fetchMock = vi.fn()

beforeEach(() => {
  toast.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function callbacks() {
  const calls: string[] = []
  return {
    calls,
    apply: () => calls.push('apply'),
    revert: () => calls.push('revert'),
  }
}

describe('savePreference', () => {
  test('success: applies, PATCHes the body, toasts, returns data', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { wake_time: '07:00' } })))
    const cb = callbacks()
    const data = await savePreference({ wake_time: '07:00' }, cb)

    expect(cb.calls).toEqual(['apply'])
    expect(fetchMock).toHaveBeenCalledWith('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wake_time: '07:00' }),
    })
    expect(toast).toHaveBeenCalledWith({ message: 'Preference saved', type: 'success' })
    expect(data).toEqual({ wake_time: '07:00' })
  })

  test('applies before the request goes out (optimistic)', async () => {
    const cb = callbacks()
    fetchMock.mockImplementation(async () => {
      expect(cb.calls).toEqual(['apply'])
      return new Response('{}')
    })
    await savePreference({ x: 1 }, cb)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('non-2xx: reverts and toasts the error message', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 400 }))
    const cb = callbacks()
    const data = await savePreference(
      { label_config: [] },
      { ...cb, successMessage: 'Labels saved', errorMessage: 'Failed to save labels' },
    )
    expect(cb.calls).toEqual(['apply', 'revert'])
    expect(toast).toHaveBeenCalledWith({ message: 'Failed to save labels', type: 'error' })
    expect(toast).toHaveBeenCalledOnce()
    expect(data).toBeUndefined()
  })

  test('network failure: reverts and toasts the default error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const cb = callbacks()
    await savePreference({ x: 1 }, cb)
    expect(cb.calls).toEqual(['apply', 'revert'])
    expect(toast).toHaveBeenCalledWith({ message: 'Failed to save preference', type: 'error' })
  })

  test('a 2xx body that is not JSON still counts as saved', async () => {
    fetchMock.mockResolvedValue(new Response('not json'))
    const cb = callbacks()
    const data = await savePreference({ x: 1 }, { ...cb, successMessage: 'Notifications enabled' })
    expect(cb.calls).toEqual(['apply'])
    expect(toast).toHaveBeenCalledWith({ message: 'Notifications enabled', type: 'success' })
    expect(data).toBeUndefined()
  })
})
