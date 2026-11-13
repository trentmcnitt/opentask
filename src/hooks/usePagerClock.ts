'use client'

import { useEffect, useState } from 'react'
import { nextPagerBoundary } from '@/lib/panel-pager'
import { openTaskDayOf } from '@/lib/opentask-day'
import { APP_ACTIVE_EVENT } from '@/hooks/useSyncStream'

/** The longest delay a browser timer takes (a 32-bit signed count of ms). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * The dashboard pager cards' clock (2026-11-13): the instant the cards read
 * the time of day from, as React state, so a card redraws exactly when a
 * period opens or the OpenTask day turns, and not only when something else
 * happens to redraw it (until then a card left open through a period's start
 * showed the old period until the next sync event).
 *
 * Advances on:
 * - one timeout for the next period start or day start (`nextPagerBoundary`),
 *   re-armed from the fresh instant after each;
 * - the page coming back: `visibilitychange` to visible, window `focus`, and
 *   the native apps' `APP_ACTIVE_EVENT`. A web view in the background and a
 *   sleeping Mac suspend timers, so one due while away fires late or not at
 *   all; the card re-reads the clock the moment it is looked at again
 *   (`useDashboardNow`'s reason).
 *
 * Returns that instant, its OpenTask day, and what they were read against.
 */
export function usePagerClock(
  startTimes: readonly string[],
  timezone: string,
  dayStart: string,
): { now: Date; day: string; basis: string } {
  const [now, setNow] = useState(() => new Date())
  const starts = startTimes.join(',')

  useEffect(() => {
    // From the wall clock, not `now`: a re-arm for new settings is not late
    // by however long ago `now` was read. `now` is a dependency so each tick
    // arms the next.
    const from = new Date(Math.max(Date.now(), now.getTime()))
    const at = nextPagerBoundary(starts ? starts.split(',') : [], timezone, dayStart, from)
    const delay = Math.min(Math.max(at.getTime() - from.getTime(), 0), MAX_TIMEOUT_MS)
    const id = setTimeout(() => setNow(new Date()), delay)
    return () => clearTimeout(id)
  }, [starts, timezone, dayStart, now])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setNow(new Date())
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener(APP_ACTIVE_EVENT, refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener(APP_ACTIVE_EVENT, refresh)
    }
  }, [])

  return {
    now,
    day: openTaskDayOf(now, timezone, dayStart),
    // What the pager reads the clock against (`ClockAck.basis`).
    basis: `${dayStart}|${timezone}|${starts}`,
  }
}
