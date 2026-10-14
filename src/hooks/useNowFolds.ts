'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Which of Now's project folds are open (`src/lib/now-view.ts`), keyed by
 * project id (`nowFoldKey`), for the browser session: a fold opened to look
 * through a project stays open across reloads and page changes until the tab
 * closes, and every fold starts shut in a new session — the front door is
 * "what matters now" again.
 *
 * Kept in `sessionStorage` behind a small external store, read through
 * `useSyncExternalStore` so the server render (no storage: every fold shut)
 * and the first client render agree, and the stored folds apply right after
 * hydration. Every storage access is wrapped: private windows and blocked
 * site data throw, and then the folds just live in memory for the visit.
 */
const STORAGE_KEY = 'opentask_now_folds'
const EMPTY: ReadonlySet<string> = new Set()

let openFolds: ReadonlySet<string> | null = null
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  if (openFolds) return openFolds
  let stored: ReadonlySet<string> = EMPTY
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) stored = new Set(parsed.filter((k) => typeof k === 'string'))
  } catch {
    // No storage (private window, blocked site data) or a damaged value: start shut.
  }
  openFolds = stored
  return stored
}

function write(next: ReadonlySet<string>): void {
  openFolds = next
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // In memory only for this visit.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const serverSnapshot = () => EMPTY

export function useNowFolds() {
  const folds = useSyncExternalStore(subscribe, read, serverSnapshot)

  const isFoldOpen = useCallback((key: string) => folds.has(key), [folds])

  const toggleFold = useCallback((key: string) => {
    const next = new Set(read())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    write(next)
  }, [])

  const openFold = useCallback((key: string) => {
    const current = read()
    if (!current.has(key)) write(new Set(current).add(key))
  }, [])

  return { isFoldOpen, toggleFold, openFold }
}
