'use client'

import { useEffect, useState } from 'react'
import { nextJustAddedTick } from '@/lib/just-added'
import type { Task } from '@/types'

/**
 * The "now" that just-added previews (`src/lib/just-added.ts`) are measured
 * against — kept current as badges count up and previews leave, without
 * a reload and without polling.
 *
 * `now` is state, not a `Date.now()` read during render (the React Compiler
 * treats render as pure). It moves forward at exactly two kinds of moment:
 *
 * 1. The next visible change. ONE `setTimeout` is scheduled for the earliest
 *    moment something just-added changes on screen — a "New · 3m" badge
 *    turning over a minute, or a task turning 10 minutes old and its preview
 *    leaving (`nextJustAddedTick`). When it fires, `now` advances and the
 *    effect schedules the next one. No task in the window, no timer. This
 *    also keeps `now` honest for tasks that arrive later: whenever a task is
 *    in the window a timer is pending, so a stale `now` can never keep an old
 *    task previewed.
 * 2. The page coming back (`visibilitychange` → visible, `focus`, `pageshow`).
 *    The Mac and iOS apps' WKWebView, and a backgrounded mobile tab, suspend
 *    JS timers, so a timeout due while suspended fires late or not at all; on
 *    return `now` is re-read so the list is right on the first frame back.
 */
export function useJustAddedClock(tasks: Task[]): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = nextJustAddedTick(tasks, now)
    if (tick === null) return
    // Measured against the real clock, not `now`: if `now` lags (a timer
    // fired late), a past-due tick runs on the next turn instead of waiting.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, tick - Date.now()))
    return () => clearTimeout(timer)
  }, [tasks, now])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
    }
  }, [])

  return now
}
