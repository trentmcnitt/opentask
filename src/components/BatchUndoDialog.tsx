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
}

export function BatchUndoDialog({
  open,
  onOpenChange,
  mode,
  count,
  onConfirm,
}: BatchUndoDialogProps) {
  const isUndo = mode === 'undo'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isUndo ? 'Undo session actions' : 'Redo actions'}</AlertDialogTitle>
          <AlertDialogDescription>
            {isUndo
              ? `This will undo ${count} actions from this session. This cannot be undone further.`
              : `This will redo ${count} actions.`}
          </AlertDialogDescription>
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
