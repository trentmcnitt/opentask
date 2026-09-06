'use client'

import { useCallback, useState } from 'react'
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
import type { ReminderGroup } from '@/hooks/useReminders'
import type { RemindersSummary } from '@/lib/reminders-summary'

/** What a "Considered all" tap is about to do, held until the user confirms. */
export type ConsiderAllRequest =
  | { kind: 'so-far'; count: number; labels: string[] }
  | { kind: 'slot'; group: ReminderGroup; label: string }

/**
 * Confirmation for the two sweep buttons on the Reminders surface — the
 * headline's "Considered all so far" and a slot's "Considered all". Trent
 * asked for it (2026-09-05): a single tap that clears 26 thoughts is easy to
 * hit by accident, and the toast's Undo is a five-second window. Marking one
 * thought, or a hand-picked selection, needs no confirmation — the user
 * already said exactly which ones.
 *
 * One line, two buttons. The confirm button carries the number so the scope
 * is in the sentence you agree to, not just the title.
 */
export function ConsiderAllDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: ConsiderAllRequest | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const count = request?.kind === 'slot' ? request.group.reminders.length : (request?.count ?? 0)
  const title =
    request?.kind === 'slot'
      ? `Consider all ${count} in ${request.label}?`
      : `Consider all ${count} waiting so far?`
  const description =
    request?.kind === 'slot'
      ? `Every thought still waiting in ${request.label} is marked considered.`
      : `Every thought still waiting in ${listLabels(request?.labels ?? [])} is marked considered.`

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description} You can undo afterward.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-consider-all-confirm>
            Consider all {count}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Holds the pending sweep until the dialog answers it. `askSoFar` / `askSlot`
 * replace what the two buttons used to do directly; `confirm` performs it.
 */
export function useConsiderAll(
  actions: { considerSoFar: () => void; completeGroup: (group: ReminderGroup) => void },
  unslottedLabel: string,
) {
  const [request, setRequest] = useState<ConsiderAllRequest | null>(null)
  const askSoFar = useCallback(
    (summary: RemindersSummary<ReminderGroup>) =>
      setRequest({
        kind: 'so-far',
        count: summary.waitingSoFar,
        labels: summary.started
          .filter((g) => g.reminders.length > 0)
          .map((g) => g.slot?.label ?? unslottedLabel),
      }),
    [unslottedLabel],
  )
  const askSlot = useCallback(
    (group: ReminderGroup) =>
      setRequest({ kind: 'slot', group, label: group.slot?.label ?? unslottedLabel }),
    [unslottedLabel],
  )
  const cancel = useCallback(() => setRequest(null), [])
  const confirm = useCallback(() => {
    setRequest(null)
    if (!request) return
    if (request.kind === 'slot') actions.completeGroup(request.group)
    else actions.considerSoFar()
  }, [request, actions])
  return { request, askSoFar, askSlot, confirm, cancel }
}

/** "Before work", "Before work and Midday", "Before work, Midday, and Afternoon". */
function listLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? 'the slots that have started'
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}
