/**
 * THE BROWSER'S DAY BOUNDARY ("Day starts at" PR 2, 2026-10-24) — the rule
 * `useDayStart` (src/components/PreferencesProvider.tsx) applies, and the
 * last one this browser saw.
 *
 * The rule is the server's `dayBoundaryForUser`: the user's day start with
 * the task queue's switch on, midnight (`CALENDAR_DAY_START`) off.
 *
 * BEFORE THE PREFERENCES LOAD the browser does not know either. Reading
 * midnight then and flipping to 03:00 a moment later moved every "today" on
 * the page — and a Defer → Tomorrow tapped in that window, between midnight
 * and the day start, landed a day late. So the boundary is REMEMBERED, the
 * way `last-known-queue.ts` remembers the switch: written once the
 * preferences have loaded, read until they do. With nothing remembered (a
 * first visit, a private window, storage blocked) it is UNKNOWN: the page
 * draws with midnight, and the actions that would commit a day — Defer's
 * "tomorrow" and "next period" — wait for the load (`useDayStartKnown`).
 *
 * A per-viewer convenience in localStorage, every access wrapped: it can be
 * empty or throw, and the page works the same without it.
 */
import { useSyncExternalStore } from 'react'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { parseHHMM } from '@/lib/time-slot-assign'

const KEY = 'opentask.dayStart'

/** A stored value as a day start, or null (malformed, or nothing stored). */
function valid(value: string | null): string | null {
  return value !== null && /^\d{2}:\d{2}$/.test(value) && parseHHMM(value) !== null ? value : null
}

/** Remember the boundary the loaded preferences gave (`useDayStart`'s rule). */
export function rememberDayStart(dayStart: string): void {
  if (!valid(dayStart)) return
  try {
    window.localStorage.setItem(KEY, dayStart)
  } catch {
    // Storage unavailable: nothing remembered, nothing breaks.
  }
}

/** The boundary this browser last saw, or null. */
export function readLastKnownDayStart(): string | null {
  try {
    return valid(window.localStorage.getItem(KEY))
  } catch {
    return null
  }
}

const noSubscribe = () => () => {}

/** The last-known boundary: null on the server and when nothing is stored. */
export function useLastKnownDayStart(): string | null {
  return useSyncExternalStore(noSubscribe, readLastKnownDayStart, () => null)
}

/**
 * The browser's day boundary, or null when it is not known yet: once the
 * preferences have loaded, the rule (the day start with the switch on,
 * midnight off); before, the remembered one.
 */
export function browserDayStart(p: {
  loaded: boolean
  taskQueue: boolean
  rolloverTime: string | null
  remembered: string | null
}): string | null {
  if (p.loaded) return p.taskQueue && p.rolloverTime ? p.rolloverTime : CALENDAR_DAY_START
  return p.remembered
}

/** What the page draws with while the boundary is unknown: midnight. */
export const UNKNOWN_DAY_START = CALENDAR_DAY_START
