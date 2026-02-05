'use client'

import { useEffect, useCallback, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface QuickActionPopoverProps {
  /** The focused task (from onMouseEnter) */
  focusedTask: Task | null
  /** Whether the popover/sheet is open */
  open: boolean
  /** Close handler */
  onClose: () => void
  /** Batched save callback - all changes are sent in a single call */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
  /** Called to delete task */
  onDelete?: (taskId: number) => void
  /** Called to navigate to task detail page */
  onNavigateToDetail?: (taskId: number) => void
}

export function QuickActionPopover({
  focusedTask,
  open,
  onClose,
  onSaveAll,
  onDelete,
  onNavigateToDetail,
}: QuickActionPopoverProps) {
  const timezone = useTimezone()
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const handleNavigateToDetail = useCallback(() => {
    if (!focusedTask || !onNavigateToDetail) return
    onNavigateToDetail(focusedTask.id)
    onClose()
  }, [focusedTask, onNavigateToDetail, onClose])

  const handleDelete = useCallback(() => {
    if (focusedTask && onDelete) {
      onDelete(focusedTask.id)
      onClose()
    }
  }, [focusedTask, onDelete, onClose])

  // Batched save handler - wraps onSaveAll with taskId and closes the popover
  const handleSaveAll = useCallback(
    (changes: QuickActionPanelChanges) => {
      if (!focusedTask) return
      onSaveAll(focusedTask.id, changes)
      onClose()
    },
    [focusedTask, onSaveAll, onClose],
  )

  const handleSave = useCallback(() => {
    onClose()
  }, [onClose])

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  // Handle dialog/sheet close
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        onClose()
      }
    },
    [onClose],
  )

  // Track dirty state from QuickActionPanel for visual indicator
  const [isPanelDirty, setIsPanelDirty] = useState(false)

  if (!focusedTask) return null

  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <QuickActionPanel
        key={focusedTask.updated_at}
        task={focusedTask}
        timezone={timezone}
        mode={isMobile ? 'sheet' : 'popover'}
        titleVariant="prominent"
        onDateChange={() => {}}
        onSaveAll={handleSaveAll}
        onDelete={onDelete ? handleDelete : undefined}
        onNavigateToDetail={onNavigateToDetail ? handleNavigateToDetail : undefined}
        onSave={handleSave}
        onCancel={handleCancel}
        onDirtyChange={setIsPanelDirty}
      />
    </div>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
          {/* Accessibility: Radix Dialog requires a title — hide it visually */}
          <VisuallyHidden>
            <SheetTitle>Quick Actions</SheetTitle>
            <SheetDescription>Adjust date, priority, and other task settings</SheetDescription>
          </VisuallyHidden>
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div className="bg-muted-foreground/30 h-1 w-10 rounded-full" />
          </div>
          <div className="px-4 pb-2">{panel}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
        <VisuallyHidden>
          <DialogTitle>Quick Actions</DialogTitle>
          <DialogDescription>Adjust date, priority, and other task settings</DialogDescription>
        </VisuallyHidden>
        {panel}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Hook to add Cmd+S / Ctrl+S shortcut for opening the quick action panel.
 */
export function useQuickActionShortcut(
  focusedTask: Task | null,
  setOpen: (open: boolean) => void,
  isOpen: boolean,
) {
  const focusedTaskRef = useRef(focusedTask)
  useEffect(() => {
    focusedTaskRef.current = focusedTask
  }, [focusedTask])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (isOpen) {
          setOpen(false)
        } else if (focusedTaskRef.current) {
          setOpen(true)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, setOpen])
}
