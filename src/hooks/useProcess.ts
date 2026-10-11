'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '@/lib/toast'
import {
  cachedProcessData,
  fetchProcess,
  rememberProcessData,
  undoEntries,
  type ProcessData,
} from '@/lib/process-client'

/** Which of Process's lists an action takes a task off. */
export type ProcessList = 'inbox' | 'growth' | 'targets'

/** Drop tasks by id from the named lists (a trashed task leaves all of them). */
export function withoutTasks(d: ProcessData, ids: Set<number>, lists: ProcessList[]): ProcessData {
  const out = { ...d }
  if (lists.includes('inbox')) out.inbox = d.inbox.filter((t) => !ids.has(t.id))
  if (lists.includes('growth')) out.growth = d.growth.filter((g) => !ids.has(g.task.id))
  if (lists.includes('targets')) {
    out.stale_targets = d.stale_targets.filter((s) => !ids.has(s.task.id))
    out.stale_targets_with_deadline = d.stale_targets_with_deadline.filter(
      (s) => !ids.has(s.task.id),
    )
  }
  return out
}

/**
 * One toast id for every Process write. Each new toast REPLACES the last, so
 * the only Undo on screen is always the newest action's — Undo here takes back
 * the latest undo entries, and an older toast's Undo would otherwise reverse
 * a later action.
 */
const PROCESS_TOAST_ID = 'process-undo'

/**
 * The Process modal's data and its undo toast. The modal remounts on every
 * opening (Header keys it), so all of this starts fresh each time.
 *
 * Reads `GET /api/process` on open, painting the cached answer first
 * (stale-while-revalidate — perceived speed is Trent's top irritation).
 *
 * Optimistic removals are remembered (`acted`) and applied to any read that
 * lands afterwards, so a fresh read that left before a tap cannot bring the
 * tapped task back. An Undo or a failed write forgets them and re-reads: the
 * server is the truth again.
 */
export function useProcess(open: boolean) {
  const [data, setDataState] = useState<ProcessData | null>(() => cachedProcessData())
  const [error, setError] = useState(false)
  const acted = useRef<{ ids: Set<number>; lists: ProcessList[] }[]>([])

  const show = useCallback((d: ProcessData) => {
    const next = acted.current.reduce((acc, a) => withoutTasks(acc, a.ids, a.lists), d)
    rememberProcessData(next)
    setDataState(next)
    setError(false)
  }, [])

  /** Take tasks off the named lists, now and in any read still on its way. */
  const remove = useCallback((ids: number[], lists: ProcessList[]) => {
    const entry = { ids: new Set(ids), lists }
    acted.current.push(entry)
    setDataState((d) => {
      if (!d) return d
      const next = withoutTasks(d, entry.ids, lists)
      rememberProcessData(next)
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    acted.current = []
    try {
      show(await fetchProcess())
    } catch {
      setError(true)
    }
  }, [show])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchProcess()
      .then((fresh) => !cancelled && show(fresh))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [open, show])

  /**
   * A success toast whose Undo takes back the `entries` undo entries the action
   * made, then re-reads. Offered only after the server confirmed the write, and
   * replacing any earlier Process toast (`PROCESS_TOAST_ID`), so its Undo is
   * always the latest action's. `onUndone` restores local state a re-read
   * can't (a duplicate group's row). With no entries (nothing changed) there
   * is nothing to undo, so no Undo is offered.
   */
  const toastWithUndo = useCallback(
    (message: string, entries = 1, onUndone?: () => void) => {
      const undo = () => {
        undoEntries(entries)
          .then((description) => {
            showToast({
              id: PROCESS_TOAST_ID,
              message: description ? `Undid: ${description}` : 'Nothing to undo',
              type: description ? 'success' : undefined,
            })
            if (description) onUndone?.()
            return reload()
          })
          .catch(() => showToast({ id: PROCESS_TOAST_ID, message: 'Undo failed', type: 'error' }))
      }
      showToast({
        id: PROCESS_TOAST_ID,
        message,
        type: 'success',
        action: entries > 0 ? { label: 'Undo', onClick: undo } : undefined,
      })
    },
    [reload],
  )

  return { data, remove, error, reload, toastWithUndo }
}
