'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSyncStream } from '@/hooks/useSyncStream'
import { trackedItems } from '@/lib/slot-view'
import { log } from '@/lib/logger'
import type { Task } from '@/types'

/**
 * The /quotas page's data: every quota, from its own endpoint, kept fresh by
 * the sync stream, with a `refresh` the page's undo/redo can reach.
 *
 * Moved out of `QuotasView` (2026-09-25) when /quotas grew a second view — the
 * dashboard's Quotas panel, `QuotasSummary` — so the two views share one fetch
 * rather than each growing its own. Only one of them is mounted at a time, so
 * there is only ever one of these running.
 */
export function useQuotasData(refreshRef?: React.MutableRefObject<(() => void) | null>) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      // This surface's OWN endpoint, the way Reminders has one. It used to ask
      // for `/api/tasks?done=false&limit=1000` and filter in the browser: 512
      // tasks over the wire to render eight, on every sync event — and a +1
      // emits a sync event, so the phone paid it for every tap.
      const res = await fetch('/api/quotas')
      if (!res.ok) throw new Error(`GET /api/quotas ${res.status}`)
      const body = await res.json()
      // Still trackedItems, not the server's order: the dashboard sorts quotas
      // by title so the order cannot jump as counts change (commit 9bcf03d,
      // "frozen order"), and the two views of the same eight things must agree.
      setTasks(trackedItems(body.data.quotas as Task[]))
      setError(null)
    } catch (err) {
      log.error('ui', 'Loading quotas failed:', err)
      // A failed BACKGROUND refresh over data we already have is not an error
      // state — the same rule useReminders keeps. This runs on every sync
      // event, so a transient 500 used to replace the list AND an open editor,
      // losing staged edits, with nothing to retry. Only a failure with
      // nothing on screen is worth showing.
      setTasks((current) => {
        if (current === null) setError('Could not load quotas.')
        return current
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // A quota is logged from the widget, the watch, a notification action and
  // other tabs. Every one of those emits a sync event, and this surface has to
  // hear them the way Reminders and the dashboard do.
  useSyncStream({ onSync: () => void refresh() })

  return { tasks, error, refresh }
}
