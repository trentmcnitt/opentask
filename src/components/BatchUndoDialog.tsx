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

  const title = isUndo
    ? context === 'session'
      ? 'Undo session actions'
      : 'Undo to here'
    : 'Redo actions'

  const description = isUndo
    ? context === 'session'
      ? `This will undo ${count} ${plural} from this session. You can redo them to restore the changes.`
      : `This will undo ${count} ${plural}. You can redo them from the activity log to restore the changes.`
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
            {isUndo ? 'Undo All' : 'Redo All'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
