'use client'

import { useCallback, useEffect, useState } from 'react'
import { showToast } from '@/lib/toast'
import {
  cachedProcessData,
  fetchProcess,
  rememberProcessData,
  undoEntries,
  type ProcessData,
} from '@/lib/process-client'

/**
 * The Process modal's data and its undo toast.
 *
 * Reads `GET /api/process` each time the modal opens, painting the cached
 * answer first (stale-while-revalidate — perceived speed is Trent's top
 * irritation). Steps remove what they act on locally and optimistically;
 * `reload` re-reads after an Undo puts something back.
 */
export function useProcess(open: boolean) {
  const [data, setDataState] = useState<ProcessData | null>(() => cachedProcessData())
  const [error, setError] = useState(false)

  /** Apply a local change (an item acted on) to the list and the cache alike. */
  const update = useCallback((change: (d: ProcessData) => ProcessData) => {
    setDataState((d) => {
      if (!d) return d
      const next = change(d)
      rememberProcessData(next)
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    try {
      setDataState(await fetchProcess())
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchProcess()
      .then((fresh) => {
        if (cancelled) return
        setDataState(fresh)
        setError(false)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [open])

  /**
   * A success toast whose Undo takes back the `entries` undo entries the action
   * made, then re-reads. Offered only after the server confirmed the write, so
   * Undo can never target the wrong action. `onUndone` restores local state
   * the re-read can't (a duplicate group's row).
   */
  const toastWithUndo = useCallback(
    (message: string, entries = 1, onUndone?: () => void) => {
      showToast({
        message,
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            undoEntries(entries)
              .then((description) => {
                showToast({
                  message: description ? `Undid: ${description}` : 'Nothing to undo',
                  type: description ? 'success' : undefined,
                })
                if (description) onUndone?.()
                return reload()
              })
              .catch(() => showToast({ message: 'Undo failed', type: 'error' }))
          },
        },
      })
    },
    [reload],
  )

  return { data, update, error, reload, toastWithUndo }
}
