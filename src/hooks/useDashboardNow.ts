'use client'

import { useEffect, useRef, useState } from 'react'
import {
  clockTickDelay,
  nextClockTick,
  sameViewScope,
  shouldAutoClearOverdueFilter,
} from '@/lib/dashboard-clock'
import type { Task } from '@/types'

/**
 * The Tasks page's single "now" — see `src/lib/dashboard-clock.ts` for why it
 * exists and exactly when it moves.
 *
 * `now` is React state, never computed during render: every overdue/today
 * memo on the page lists it as a dependency, so they all recompute together,
 * with the same instant, exactly when it advances — and not on every render.
 *
 * Advances on:
 * - **one timeout** for the next instant any date bucket can change
 *   (`nextClockTick`). It is re-armed from the fresh `now` after every tick
 *   and whenever the task list changes, so a clamped or early wake-up simply
 *   re-arms for the remainder.
 * - **`visibilitychange` (to visible) and window `focus`.** The Mac/iOS apps'
 *   WKWebView, a backgrounded tab, and a sleeping laptop all suspend timers;
 *   a timeout that should have fired while suspended fires late, so the page
 *   re-reads the clock the moment it is looked at again.
 */
export function useDashboardNow(tasks: Task[], timezone: string): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const delay = clockTickDelay(nextClockTick(tasks, now, timezone), now)
    const id = setTimeout(() => setNow(new Date()), delay)
    return () => clearTimeout(id)
  }, [tasks, now, timezone])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setNow(new Date())
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return now
}

/**
 * Switch the Overdue date filter off when its last task stops being overdue
 * — done, snoozed, rescheduled, here or on another device via sync. The rule
 * (a transition from >0 to 0 while selected; never on a 0 → 0 deep link) is
 * `shouldAutoClearOverdueFilter`. `overdueCount` is the date-facet count the
 * red pill and pinned chip show, so "none left" means what those say.
 *
 * **Only the TASKS moving counts as "none left".** The facet count also drops
 * when the user narrows the view — picks a project with nothing overdue, types
 * a search, opens Recent — and clearing Overdue then would undo half of what
 * they just asked for. So `scope` lists what defines the view (the filter
 * criteria, the search query AND its hit list — hits arrive a beat after the
 * query changes — and the grouping); when any entry changes, that
 * observation becomes a fresh baseline instead of a transition. The same rule
 * keeps a `?project=…` deep link's filter landing (an effect, one render
 * after the first) from reading as "the overdue tasks went away".
 *
 * `clearOverdue` must remove ONLY the Overdue date filter, leaving any other
 * filter — Today, a project — where it was. `notify` raises a calm,
 * action-less toast saying why the list just changed; the snooze/done that
 * emptied it has its own Undo toast, and undoing brings the task back without
 * re-selecting the filter, which is fine: the filter was a view, not data.
 */
export function useAutoClearOverdueFilter(
  overdueCount: number,
  overdueSelected: boolean,
  scope: readonly unknown[],
  clearOverdue: () => void,
  notify: () => void,
): void {
  const prev = useRef<{ count: number; scope: readonly unknown[] } | null>(null)
  useEffect(() => {
    const last = prev.current
    prev.current = { count: overdueCount, scope }
    const prevCount = last !== null && sameViewScope(last.scope, scope) ? last.count : null
    if (shouldAutoClearOverdueFilter(prevCount, overdueCount, overdueSelected)) {
      clearOverdue()
      notify()
    }
  }, [overdueCount, overdueSelected, scope, clearOverdue, notify])
}
