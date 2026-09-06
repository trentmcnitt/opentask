'use client'

import { useEffect, useSyncExternalStore } from 'react'
import type { TaskCounts } from '@/lib/task-counts'

/**
 * The Tasks page's numbers for the nav, on every page.
 *
 * Trent (2026-09-05): "when you're in reminders you don't know what's going
 * on over in tasks." Same shape as the reminders badge cache: a module-level
 * value, read through useSyncExternalStore (a plain render-time read of
 * module state is invisible to the React Compiler and memoises to its first
 * value), filled by GET /api/tasks/counts when empty and on window focus.
 * The Tasks page itself publishes its live numbers here as they change, so
 * the badge never disagrees with the top bar beside it.
 */
let cache: TaskCounts | null = null
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const read = () => cache
const readServer = () => null

/** The Tasks page calls this with the counts it just rendered. */
export function publishTaskCounts(next: TaskCounts): void {
  if (
    cache &&
    cache.total === next.total &&
    cache.overdue === next.overdue &&
    cache.today === next.today
  )
    return
  cache = next
  for (const listener of listeners) listener()
}

function load(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const res = await fetch('/api/tasks/counts')
      if (!res.ok) return
      const json = await res.json()
      const data = json?.data
      if (data && typeof data.total === 'number') {
        publishTaskCounts({ total: data.total, overdue: data.overdue ?? 0, today: data.today ?? 0 })
      }
    } catch {
      // A badge that keeps its last value beats one that flickers.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function useTaskNavCounts(): TaskCounts | null {
  const counts = useSyncExternalStore(subscribe, read, readServer)
  useEffect(() => {
    if (cache === null) void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return counts
}
