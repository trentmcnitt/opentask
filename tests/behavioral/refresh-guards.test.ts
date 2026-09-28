/**
 * Refresh guards (`src/lib/refresh-guards.ts`): the resume-refresh dedupe used
 * by `useSyncStream`, and the latest-request guard used by the dashboard's
 * task fetch and the Reminders refresh.
 */
import { describe, expect, it } from 'vitest'
import {
  RESUME_REFRESH_DEDUPE_MS,
  createLatestRequestGuard,
  shouldResumeRefresh,
} from '@/lib/refresh-guards'

describe('shouldResumeRefresh', () => {
  const t0 = 1_800_000_000_000

  it('refreshes when no full refresh has run yet', () => {
    expect(shouldResumeRefresh(null, t0)).toBe(true)
  })

  it('skips while a refresh started inside the window', () => {
    expect(shouldResumeRefresh(t0, t0)).toBe(false)
    expect(shouldResumeRefresh(t0, t0 + RESUME_REFRESH_DEDUPE_MS - 1)).toBe(false)
  })

  it('refreshes once the window has passed', () => {
    expect(shouldResumeRefresh(t0, t0 + RESUME_REFRESH_DEDUPE_MS)).toBe(true)
    expect(shouldResumeRefresh(t0, t0 + 60_000)).toBe(true)
  })

  it('refreshes when the clock went backwards', () => {
    expect(shouldResumeRefresh(t0, t0 - 1)).toBe(true)
  })

  it('honours a custom window', () => {
    expect(shouldResumeRefresh(t0, t0 + 500, 1000)).toBe(false)
    expect(shouldResumeRefresh(t0, t0 + 1000, 1000)).toBe(true)
  })
})

describe('createLatestRequestGuard', () => {
  it('accepts the only request in flight', () => {
    const guard = createLatestRequestGuard()
    const a = guard.begin()
    expect(guard.isLatest(a)).toBe(true)
  })

  it('rejects an older response that resolves after a newer request began', () => {
    const guard = createLatestRequestGuard()
    const older = guard.begin()
    const newer = guard.begin()
    // The newer one resolves first and applies…
    expect(guard.isLatest(newer)).toBe(true)
    // …and the older one, arriving late, is dropped.
    expect(guard.isLatest(older)).toBe(false)
  })

  it('rejects the older response even if it resolves first', () => {
    const guard = createLatestRequestGuard()
    const older = guard.begin()
    guard.begin()
    expect(guard.isLatest(older)).toBe(false)
  })

  it('keeps separate sequences per guard', () => {
    const a = createLatestRequestGuard()
    const b = createLatestRequestGuard()
    const seqA = a.begin()
    b.begin()
    b.begin()
    expect(a.isLatest(seqA)).toBe(true)
  })
})
