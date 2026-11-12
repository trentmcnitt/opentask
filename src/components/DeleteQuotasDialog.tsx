'use client'

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
import { Button } from '@/components/ui/button'
import type { DeletedQuota } from '@/hooks/useReminders'
import type { Task } from '@/types'

/** A Delete tapped with a quota prompt in the selection, held until answered. */
export interface DeleteQuotasRequest {
  reminders: Task[]
  /** The quotas behind the selected prompt rows, one each. */
  quotas: DeletedQuota[]
}

/**
 * THE ONE CONFIRMATION before a selection on the Reminders tab deletes a
 * QUOTA (Trent, 2026-11-12: "I think we go with one confirmation").
 *
 * A prompt row is today's nudge for a quota; Delete on it deletes the quota
 * itself, every day's prompt with it. That is more than the row says, so the
 * dialog says it — once for the whole selection, never one dialog per quota:
 * the title counts the quotas, the list names each (two prompts of one quota
 * are one quota), and the line under it says what goes.
 *
 * Three answers: delete everything selected; delete the reminders only (shown
 * only when the selection has reminders); cancel, which changes nothing and
 * keeps the selection. Reminders alone never come here — they delete at once,
 * as before, with the toast's Undo. Everything is a soft delete to Trash and
 * one undo entry.
 */
export function DeleteQuotasDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: DeleteQuotasRequest | null
  onConfirm: (scope: 'all' | 'reminders') => void
  onCancel: () => void
}) {
  const quotas = request?.quotas ?? []
  const reminders = request?.reminders.length ?? 0
  const one = quotas.length === 1
  const title = one ? 'Delete this quota?' : `Delete ${quotas.length} quotas?`
  const what = one
    ? 'This deletes the quota itself, not just today’s prompt.'
    : 'This deletes each quota itself, not just today’s prompt.'
  const also =
    reminders === 0
      ? ''
      : reminders === 1
        ? ' The reminder is deleted either way.'
        : ` The ${reminders} reminders are deleted either way.`
  const all =
    reminders > 0
      ? `Delete all ${reminders + quotas.length}`
      : one
        ? 'Delete quota'
        : `Delete ${quotas.length} quotas`

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="max-w-sm" data-delete-quotas-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <ul className="text-foreground list-disc space-y-0.5 pl-5 text-left text-sm">
            {quotas.map((q) => (
              <li key={q.id} data-delete-quota={q.id} className="break-words">
                {q.title}
              </li>
            ))}
          </ul>
          <AlertDialogDescription>
            {what}
            {also} You can undo afterward.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          {reminders > 0 && (
            <Button variant="outline" onClick={() => onConfirm('reminders')}>
              Reminders only
            </Button>
          )}
          <AlertDialogAction
            onClick={() => onConfirm('all')}
            className="bg-destructive hover:bg-destructive/90 text-white"
          >
            {all}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
