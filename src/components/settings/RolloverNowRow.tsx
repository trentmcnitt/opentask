'use client'

/**
 * Settings → Snooze → "Roll over now" (task queue, 2026-10-20): run the
 * rollover by hand — "end my day now" (`POST /api/rollover/run-now`,
 * src/core/tasks/rollover-now.ts). Only with the server's task queue on
 * (`useTaskQueue`); hidden otherwise, and while preferences load.
 *
 * A tap first asks the server what a run would do (`?dry_run=1`). Nothing
 * eligible: a toast says so, no dialog. Otherwise a confirm names the count
 * ("Move 7 tasks to the queue?", the repeating ones only when there are any)
 * — this moves many tasks at once, so it asks, like "Consider all" — then the
 * run, and a toast whose Undo reverses exactly this run (its `undo_id`, the
 * period-delete pattern in `TimeSlotSettings`).
 */

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTaskQueue } from '@/components/PreferencesProvider'
import { apiFetch, jsonInit } from '@/lib/api-client'
import { showToast } from '@/lib/toast'
import { SettingRow } from './SettingRow'

interface RunNowResult {
  stripped: number
  rolled: number
  waiting: number
  released: number
  undo_id: number | null
}

const RUN_NOW_URL = '/api/rollover/run-now'

function tasks(n: number): string {
  return `${n} ${n === 1 ? 'task' : 'tasks'}`
}

function total(r: RunNowResult): number {
  return r.stripped + r.rolled + r.waiting + r.released
}

/** The confirm's title: the one-offs, the bulk of any run. */
export function runNowTitle(r: RunNowResult): string {
  return r.stripped > 0 ? `Move ${tasks(r.stripped)} to the queue?` : 'Roll over now?'
}

/** The confirm's detail: the repeating tasks, only the counts that aren't zero. */
export function runNowDetail(r: RunNowResult): string {
  const parts: string[] = []
  if (r.waiting > 0) parts.push(`${r.waiting} repeating wait in the queue for their next time`)
  if (r.rolled > 0) parts.push(`${r.rolled} repeating move to their next time`)
  if (r.released > 0) parts.push(`${r.released} repeating come back today`)
  return parts.length > 0 ? `${parts.join('; ')}.` : ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong'
}

export function RolloverNowRow() {
  const { loaded, enabled } = useTaskQueue()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RunNowResult | null>(null)

  // Undo exactly this run: only while it is still the newest undoable entry
  // (else a later change would be undone with it — `TimeSlotSettings`' rule).
  const undo = useCallback(async (undoId: number) => {
    try {
      const { history } = await apiFetch<{ history: { id: number; undone: boolean }[] }>(
        '/api/undo/history?limit=20',
      )
      if (history.find((e) => !e.undone)?.id !== undoId) {
        showToast({
          message: 'Something else changed since — undo it from History instead',
          type: 'error',
        })
        return
      }
      await apiFetch('/api/undo/batch', jsonInit('POST', { through_id: undoId }))
      showToast({ message: 'Undone', type: 'success' })
    } catch (err) {
      showToast({ message: errorMessage(err), type: 'error' })
    }
  }, [])

  const ask = async () => {
    setBusy(true)
    try {
      const dry = await apiFetch<RunNowResult>(`${RUN_NOW_URL}?dry_run=1`, { method: 'POST' })
      if (total(dry) === 0) showToast({ message: 'Nothing to roll over' })
      else setPreview(dry)
    } catch (err) {
      showToast({ message: errorMessage(err), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setPreview(null)
    setBusy(true)
    try {
      const r = await apiFetch<RunNowResult>(RUN_NOW_URL, { method: 'POST' })
      const message =
        r.stripped > 0
          ? `Moved ${tasks(r.stripped)} to the queue`
          : total(r) > 0
            ? `Rolled over ${tasks(total(r))}`
            : 'Nothing to roll over'
      const undoId = r.undo_id
      showToast({
        message,
        type: 'success',
        action: undoId === null ? undefined : { label: 'Undo', onClick: () => void undo(undoId) },
      })
    } catch (err) {
      showToast({ message: errorMessage(err), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (!loaded || !enabled) return null
  const detail = preview ? runNowDetail(preview) : ''
  return (
    <>
      <SettingRow
        label="Roll over now"
        description="End your day now: tasks past their target go to the queue"
      >
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={busy}
          onClick={() => void ask()}
          data-rollover-now
        >
          Roll over now
        </Button>
      </SettingRow>
      <AlertDialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{preview ? runNowTitle(preview) : ''}</AlertDialogTitle>
            <AlertDialogDescription>
              {detail ? `${detail} ` : ''}You can undo afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run()} data-rollover-now-confirm>
              Roll over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
