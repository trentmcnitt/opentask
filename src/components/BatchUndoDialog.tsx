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

interface BatchUndoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'undo' | 'redo'
  count: number
  onConfirm: () => void
  /** Controls dialog title and description wording. Default: 'session'. */
  context?: 'session' | 'history'
}

export function BatchUndoDialog({
  open,
  onOpenChange,
  mode,
  count,
  onConfirm,
  context = 'session',
}: BatchUndoDialogProps) {
  const isUndo = mode === 'undo'
  const plural = count === 1 ? 'action' : 'actions'

  const single = count === 1

  const title = isUndo
    ? context === 'session'
      ? single
        ? 'Undo action'
        : 'Undo session actions'
      : single
        ? 'Undo action'
        : 'Undo to here'
    : single
      ? 'Redo action'
      : 'Redo actions'

  const description = isUndo
    ? context === 'session'
      ? single
        ? 'This will undo the last action from this session. You can redo it to restore the change.'
        : `This will undo ${count} ${plural} from this session. You can redo them to restore the changes.`
      : single
        ? 'This will undo this action. You can redo it from the activity log to restore the change.'
        : `This will undo ${count} ${plural}. You can redo them from the activity log to restore the changes.`
    : single
      ? 'This will redo this action.'
      : `This will redo ${count} ${plural}.`

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="default" onClick={onConfirm}>
            {isUndo ? (count === 1 ? 'Undo' : 'Undo All') : count === 1 ? 'Redo' : 'Redo All'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
