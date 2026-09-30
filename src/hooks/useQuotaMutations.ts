'use client'

import { useCallback } from 'react'
import { showSaveError, showToast } from '@/lib/toast'
import { saveTaskChanges } from '@/lib/save-task-changes'
import { log } from '@/lib/logger'
import type { QuotaChanges } from '@/components/QuotaDetail'
import type { Task } from '@/types'

/**
 * The three writes a quota surface makes: save, create, delete.
 *
 * Lifted out of `QuotasView` (2026-09-21) so `TrackPanel`'s new in-place
 * editor — `QuotaDetailModal`, opened from a Track chip's popover — makes
 * the EXACT same writes the `/quotas` page does: same endpoints, same toast
 * wording, same Undo. The alternative was a second, independent
 * implementation of "save/create/delete a quota" that could silently drift
 * from this one. Its one caller now is `useQuotaEditor`, which every quota
 * surface mounts (`QuotasView`, `QuotasSummary`, `TrackPanel`, the quota
 * prompts) along with the modal these writes serve.
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
      // One quota is a PATCH through `saveTaskChanges`, the single-task save
      // every other editor uses; several is the bulk endpoint — one request,
      // one undo entry — exactly as the Reminders editor does it.
      //
      // A refusal toasts the server's own reason (a label the registry
      // doesn't know, a target out of range) and rejects, so the editor keeps
      // the staged edits for a retry.
      try {
        if (ids.length === 1) {
          await saveTaskChanges(ids[0], changes)
        } else {
          const res = await fetch('/api/tasks/bulk/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, changes }),
          })
          if (!res.ok) throw new Error(await serverError(res, 'Could not save those quotas'))
        }
      } catch (err) {
        showSaveError(err)
        throw err
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
      // As a save: the server's reason on a refusal, and a rejection so the
      // new-quota form keeps what was typed.
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        })
        if (!res.ok) throw new Error(await serverError(res, 'Could not create the quota'))
      } catch (err) {
        showSaveError(err)
        throw err
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

/** The `error` of a refused request's `{ error, code }` body, or `fallback`. */
async function serverError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error || fallback
}
