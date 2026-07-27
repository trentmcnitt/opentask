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
import { formatDateTime } from '@/lib/format-date'
import type { SnoozeGuard } from '@/lib/snooze-guard'

interface SnoozeGuardDialogProps {
  /** The guard to display, or null when no confirmation is pending */
  guard: SnoozeGuard | null
  timezone: string
  /** Proceed with the snooze exactly as the user asked */
  onConfirm: () => void
  /** Only offered for `past-next-occurrence`: snooze to the occurrence instead */
  onSnoozeToNextOccurrence: () => void
  onCancel: () => void
}

/**
 * Confirmation for the two snooze situations that are usually a mistake
 * (REDESIGN-V03 §4.3). Rendered by single-task snooze surfaces only — bulk
 * sweeps must never modal-block, so no bulk path constructs this.
 *
 * The layout is deliberate: **"Snooze anyway" is the primary action** in both
 * variants. The app warns, it does not overrule — the user's explicit
 * instruction stays the path of least resistance, and the alternative sits
 * beside it as an equal offer rather than a correction. Silent clamping to the
 * next occurrence was proposed in design and rejected for exactly this reason.
 *
 * The three-way variant stacks its buttons because "snooze to next occurrence"
 * carries a date and does not fit a single footer row on a 375px viewport.
 */
export function SnoozeGuardDialog({
  guard,
  timezone,
  onConfirm,
  onSnoozeToNextOccurrence,
  onCancel,
}: SnoozeGuardDialogProps) {
  const open = guard !== null

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel()
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-sm">
        {guard?.kind === 'past-next-occurrence' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Snooze past the next occurrence?</AlertDialogTitle>
              <AlertDialogDescription>
                This pushes past its next occurrence (
                {formatDateTime(guard.nextOccurrence, timezone)}), so that one won&apos;t come up.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <AlertDialogAction onClick={onConfirm} className="w-full">
                Snooze anyway
              </AlertDialogAction>
              <Button variant="outline" onClick={onSnoozeToNextOccurrence} className="w-full">
                Snooze to next occurrence
              </Button>
              <AlertDialogCancel onClick={onCancel} className="mt-0 w-full">
                Cancel
              </AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Add a due date?</AlertDialogTitle>
              <AlertDialogDescription>
                This task has no due date. Snoozing it will give it one, and it will start showing
                up as due.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onConfirm}>Set due date</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
