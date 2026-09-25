'use client'

import { useCallback } from 'react'
import { showToast } from '@/lib/toast'
import { log } from '@/lib/logger'
import type { QuotaChanges } from '@/components/QuotaDetail'
import type { Task } from '@/types'

/**
 * The three writes a quota surface makes: save, create, delete.
 *
 * Lifted out of `QuotasView` (2026-09-21) so `TrackPanel`'s new in-place
 * editor — `QuotaDetailModal`, opened from a Track chip's popover — makes
 * the EXACT same writes the `/quotas` page does: same endpoints, same toast
 * wording, same Undo. `QuotasView` remains this hook's primary caller and
 * its own behavior is unchanged by the move; the alternative was a second,
 * independent implementation of "save/create/delete a quota" that could
 * silently drift from this one.
 */
export function useQuotaMutations({
  refresh,
  clear,
  onUndo,
  onCompleted,
}: {
  refresh: () => Promise<void>
  clear: () => void
  onUndo: () => void
  onCompleted: () => void
}) {
  /** Every one of these goes through an undoable core mutation, so every one
   *  offers the Undo — the same contract `useReminders` keeps. */
  const undoAction = useCallback(() => ({ label: 'Undo', onClick: () => onUndo() }), [onUndo])
  const saveQuotas = useCallback(
    async (ids: number[], changes: QuotaChanges, options: { message?: string } = {}) => {
      // One quota is a PATCH; several is the bulk endpoint — one request, one
      // undo entry — exactly as the Reminders editor does it.
      const res =
        ids.length === 1
          ? await fetch(`/api/tasks/${ids[0]}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(changes),
            })
          : await fetch('/api/tasks/bulk/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids, changes }),
            })
      if (!res.ok) {
        showToast({ message: 'Could not save those quotas', type: 'error' })
        throw new Error(`save quotas ${res.status}`)
      }
      showToast({
        // A caller whose one change has a better name says so (a prompt's
        // period chips: "Moved … to Evening"); the write itself is the same.
        message:
          options.message ?? (ids.length === 1 ? 'Quota updated' : `Updated ${ids.length} quotas`),
        type: 'success',
        action: undoAction(),
      })
      onCompleted()
      clear()
      await refresh()
    },
    [clear, refresh, undoAction, onCompleted],
  )

  const createQuota = useCallback(
    async (changes: QuotaChanges) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      if (!res.ok) {
        showToast({ message: 'Could not create the quota', type: 'error' })
        throw new Error(`create quota ${res.status}`)
      }
      showToast({ message: 'Quota created', type: 'success', action: undoAction() })
      onCompleted()
      await refresh()
    },
    [refresh, undoAction, onCompleted],
  )

  const deleteQuotas = useCallback(
    async (targets: Task[]) => {
      const ids = targets.map((t) => t.id)
      try {
        const res = await fetch('/api/tasks/bulk/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error(`bulk/delete ${res.status}`)
        showToast({
          message:
            targets.length === 1
              ? `Moved “${targets[0].title}” to Trash`
              : `Moved ${targets.length} quotas to Trash`,
          type: 'success',
          action: undoAction(),
        })
        onCompleted()
        clear()
        await refresh()
      } catch (err) {
        log.error('ui', 'Deleting quotas failed:', err)
        showToast({ message: 'Could not move those to Trash', type: 'error' })
      }
    },
    [clear, refresh, undoAction, onCompleted],
  )

  return { saveQuotas, createQuota, deleteQuotas }
}
