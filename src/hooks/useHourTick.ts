'use client'

import { useSyncExternalStore } from 'react'
import { nextTopOfHour } from '@/lib/lean-chip-words'

/**
 * THE HOUR TICK: the time, read at each local top of the hour (and when
 * the first row starts listening) — what the lean row uses as "now" for its
 * chip words, so render never reads the clock itself. Re-read at each hour — ONE timer per time zone however many rows listen, aligned to
 * the hour, never a per-minute tick. The lean row's deadline countdown
 * ("in 5 hrs") changes only on the hour (`countdownWords`), so this is all
 * it needs to stay right.
 *
 * The timer runs only while something listens, and re-arms itself for the
 * next hour each time it fires. The server snapshot is 0 (no clock there);
 * the client's first read is the mount time.
 */
interface Clock {
  tick: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | null
}

const clocks = new Map<string, Clock>()

function clockFor(timezone: string): Clock {
  let clock = clocks.get(timezone)
  if (!clock) {
    clock = { tick: Date.now(), listeners: new Set(), timer: null }
    clocks.set(timezone, clock)
  }
  return clock
}

function arm(timezone: string, clock: Clock) {
  const now = new Date()
  clock.timer = setTimeout(
    () => {
      clock.tick = Date.now()
      for (const listener of clock.listeners) listener()
      arm(timezone, clock)
    },
    nextTopOfHour(now, timezone).getTime() - now.getTime(),
  )
}

export function useHourTick(timezone: string): number {
  return useSyncExternalStore(
    (listener) => {
      const clock = clockFor(timezone)
      clock.listeners.add(listener)
      if (!clock.timer) {
        // Waking from idle: the time read before may be hours old.
        clock.tick = Date.now()
        arm(timezone, clock)
        listener()
      }
      return () => {
        clock.listeners.delete(listener)
        if (clock.listeners.size === 0 && clock.timer) {
          clearTimeout(clock.timer)
          clock.timer = null
        }
      }
    },
    () => clockFor(timezone).tick,
    () => 0,
  )
}
