'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '@/lib/toast'
import { postUndoRedo, type UndoRedoKind } from '@/lib/undo-client'

/**
 * Single-step undo/redo for a page: the handlers behind the Header's buttons,
 * Cmd+Z / Cmd+Shift+Z (`useUndoRedoShortcuts`) and every toast's Undo action.
 *
 * Used directly by the Reminders, Quotas and History pages, and through
 * `useTaskActions` by the dashboard and the task page.
 *
 * SESSION SCOPE (`sessionScoped`, default true). On mount the hook records the
 * latest `undo_log` id as a watermark and sends it with every request, so undo
 * only reaches actions taken since the page loaded, and the counts — which
 * start at 0 — are this session's. Unscoped, no watermark is fetched or sent:
 * undo reaches the latest action of any age, and the toast carries no
 * "· N left" suffix, because the server's counts then cover the whole log.
 *
 * The handlers are also published through refs, which break the circular
 * dependency between them — each toast's action calls the other one — and let
 * the keyboard shortcut hook read the latest handler. The refs are filled in an
 * effect (the React Compiler lint refuses a ref write during render); every
 * reader is an event handler or a toast action, which only runs after commit.
 */

interface UseUndoRedoOptions {
  /** Re-fetch what the page shows after an undo/redo lands. */
  onRefresh: () => void
  sessionScoped?: boolean
}

const LABELS: Record<UndoRedoKind, { done: string; nothing: string; failed: string }> = {
  undo: { done: 'Undid', nothing: 'Nothing to undo', failed: 'Undo failed' },
  redo: { done: 'Redid', nothing: 'Nothing to redo', failed: 'Redo failed' },
}

export function useUndoRedo({ onRefresh, sessionScoped = true }: UseUndoRedoOptions) {
  // Kept in a ref so the handlers stay stable across renders.
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  })

  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  // Session watermark: the latest undo_log ID at page load. Actions after this ID
  // are "this session's" actions. Used to scope undo/redo counts to the session.
  const sessionWatermarkRef = useRef<number | null>(null)
  // Fetch the session watermark on mount (don't set counts — session starts at 0)
  useEffect(() => {
    if (!sessionScoped) return
    fetch('/api/undo/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.data) return
        sessionWatermarkRef.current = data.data.latest_id ?? null
      })
      .catch(() => {})
  }, [sessionScoped])

  // Undo/redo refs break the circular dependency between the two handlers
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)
  const handleRedoRef = useRef<(() => Promise<void>) | null>(null)

  const run = useCallback(
    async (kind: UndoRedoKind) => {
      const labels = LABELS[kind]
      try {
        const data = await postUndoRedo(kind, sessionScoped ? sessionWatermarkRef.current : null)
        if (!data) {
          showToast({ message: labels.nothing })
          return
        }
        if (typeof data.undoable_count === 'number') setUndoCount(data.undoable_count)
        if (typeof data.redoable_count === 'number') setRedoCount(data.redoable_count)
        onRefreshRef.current()
        const remaining = kind === 'undo' ? data.undoable_count : data.redoable_count
        const countSuffix =
          sessionScoped && typeof remaining === 'number' ? ` · ${remaining} left` : ''
        const opposite = kind === 'undo' ? handleRedoRef : handleUndoRef
        showToast({
          message: `${labels.done}: ${data.description}${countSuffix}`,
          type: 'success',
          action: {
            label: kind === 'undo' ? 'Redo' : 'Undo',
            onClick: () => opposite.current?.(),
          },
        })
      } catch {
        showToast({ message: labels.failed, type: 'error' })
      }
    },
    [sessionScoped],
  )

  const handleUndo = useCallback(() => run('undo'), [run])
  const handleRedo = useCallback(() => run('redo'), [run])

  useEffect(() => {
    handleUndoRef.current = handleUndo
    handleRedoRef.current = handleRedo
  }, [handleUndo, handleRedo])

  /** Increment undo count by 1 and clear redo. Call after any successful mutation. */
  const bumpUndoCount = useCallback(() => {
    setUndoCount((c) => c + 1)
    setRedoCount(0)
  }, [])

  return {
    handleUndo,
    handleRedo,
    handleUndoRef,
    handleRedoRef,
    undoCount,
    redoCount,
    bumpUndoCount,
  }
}
