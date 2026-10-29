'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * The dashboard task list's row style, per device (Settings → Theme → Task
 * rows): the LEAN row (`LeanRow`: a done square, hairlines, no card), the
 * CARD row (`TaskRow`), or CARD V2 (2026-10-29, Trent's "C1 · Separate
 * cards": the lean row's contents in a separate card with a state edge —
 * `LeanRow`'s `card-v2` look). Per device like the theme, so trying one on a
 * phone never changes the desktop.
 *
 * The default is the build's: `NEXT_PUBLIC_DEFAULT_TASK_ROWS=lean` (the dev
 * build, while Trent tries the lean row), otherwise the card — production and
 * CI build without it, so every existing row test sees the card. A choice
 * made in Settings overrides the default on that device.
 *
 * Kept in `localStorage` behind a small external store, read through
 * `useSyncExternalStore` so the server render (the build default) and the
 * first client render agree, and a stored choice applies right after
 * hydration. Every storage access is wrapped: private windows and blocked
 * site data throw, and then the choice lives in memory for the visit.
 */
export type TaskRowStyle = 'lean' | 'card' | 'card-v2'

const STORAGE_KEY = 'opentask_task_rows'
const STYLES: readonly TaskRowStyle[] = ['lean', 'card', 'card-v2']
const BUILD_DEFAULT = process.env.NEXT_PUBLIC_DEFAULT_TASK_ROWS
const DEFAULT: TaskRowStyle = isStyle(BUILD_DEFAULT) ? BUILD_DEFAULT : 'card'

let current: TaskRowStyle | null = null
const listeners = new Set<() => void>()

function isStyle(value: unknown): value is TaskRowStyle {
  return (STYLES as readonly unknown[]).includes(value)
}

function read(): TaskRowStyle {
  if (current) return current
  let stored: TaskRowStyle = DEFAULT
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (isStyle(raw)) stored = raw
  } catch {
    // No storage: the build default.
  }
  current = stored
  return stored
}

function write(next: TaskRowStyle): void {
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // In memory only for this visit.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const serverSnapshot = () => DEFAULT

export function useTaskRowStyle() {
  const style = useSyncExternalStore(subscribe, read, serverSnapshot)
  const setStyle = useCallback((next: TaskRowStyle) => write(next), [])
  return { style, setStyle }
}
