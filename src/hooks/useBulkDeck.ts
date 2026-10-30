'use client'

import { useCallback } from 'react'
import { useDayStart } from '@/components/PreferencesProvider'
import { useTimezone } from '@/hooks/useTimezone'
import { deckToastMessage, sendDeck } from '@/lib/deck-request'
import { showSaveError, showToast } from '@/lib/toast'
import { taskWord } from '@/lib/utils'

/**
 * DECK A SELECTION (the U1 bar's Deck, Trent 2026-10-30): one `POST
 * /api/tasks/deck` for every selected task — one undo entry — and the deck's
 * own toast with Undo ("On deck for tomorrow: 3 tasks"). The server skips and
 * refuses per task (a repeating task, a deadline's limit); when nothing was
 * decked the toast says why (`summary`). The caller refreshes and clears.
 */
export function useBulkDeck({
  onUndo,
  onUndoable,
  onFinished,
}: {
  /** The toast's Undo. */
  onUndo: () => void
  /** A write that made an undo entry (the dashboard's undo count). */
  onUndoable?: () => void
  /** After the request, whatever it answered: refresh, clear the selection. */
  onFinished: () => void
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  return useCallback(
    async (ids: number[], day: string | null) => {
      try {
        const result = await sendDeck(ids, day)
        const moved = day === null ? result.undecked : result.decked
        const message = deckToastMessage(result, `${moved} ${taskWord(moved)}`, timezone, dayStart)
        if (!message) {
          showToast({ message: result.summary, type: 'error' })
          return
        }
        onUndoable?.()
        showToast({ message, type: 'success', action: { label: 'Undo', onClick: onUndo } })
      } catch (err) {
        showSaveError(err)
      } finally {
        onFinished()
      }
    },
    [timezone, dayStart, onUndo, onUndoable, onFinished],
  )
}
