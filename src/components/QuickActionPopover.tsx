'use client'

import { useEffect, useCallback, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import type { Task } from '@/types'

interface QuickActionPopoverProps {
  /** The focused task (from onMouseEnter) */
  focusedTask: Task | null
  /** Whether the popover/sheet is open */
  open: boolean
  /** Close handler */
  onClose: () => void
  /** Called to save the date change (snooze or patch) */
  onDateSave: (taskId: number, isoUtc: string) => void
  /** Called on priority change with absolute priority (0-4) */
  onPriorityChange?: (taskId: number, newPriority: number) => void
  /** Called when recurrence changes */
  onRruleChange?: (
    taskId: number,
    rrule: string | null,
    recurrenceMode?: 'from_due' | 'from_completion',
  ) => void
  /** Called to delete task */
  onDelete?: (taskId: number) => void
  /** Called to navigate to task detail page */
  onNavigateToDetail?: (taskId: number) => void
  /** Called to open project picker for task */
  onMoveToProject?: (taskId: number) => void
}

export function QuickActionPopover({
  focusedTask,
  open,
  onClose,
  onDateSave,
  onPriorityChange,
  onRruleChange,
  onDelete,
  onNavigateToDetail,
  onMoveToProject,
}: QuickActionPopoverProps) {
  const timezone = useTimezone()
  const [isMobile, setIsMobile] = useState(false)
  // Track pending date change - use state keyed by open+taskId to auto-reset
  const [pendingDate, setPendingDate] = useState<string | null>(null)
  // Track the task ID we last had a pending date for, to reset when task changes
  const lastTaskIdRef = useRef<number | null>(null)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Track date changes but don't save immediately
  const handleDateChange = useCallback(
    (isoUtc: string) => {
      // If task changed since last pending date, this will naturally overwrite
      setPendingDate(isoUtc)
      lastTaskIdRef.current = focusedTask?.id ?? null
    },
    [focusedTask?.id],
  )

  // Save button: apply pending date change and close
  const handleSave = useCallback(() => {
    // Only save if pending date is for the current task
    if (focusedTask && pendingDate && lastTaskIdRef.current === focusedTask.id) {
      onDateSave(focusedTask.id, pendingDate)
    }
    setPendingDate(null)
    onClose()
  }, [focusedTask, pendingDate, onDateSave, onClose])

  // Cancel button: discard changes and close
  const handleCancel = useCallback(() => {
    setPendingDate(null)
    onClose()
  }, [onClose])

  const handlePriorityChange = useCallback(
    (priority: number) => {
      if (!focusedTask || !onPriorityChange) return
      onPriorityChange(focusedTask.id, priority)
    },
    [focusedTask, onPriorityChange],
  )

  const handleNavigateToDetail = useCallback(() => {
    if (!focusedTask || !onNavigateToDetail) return
    onNavigateToDetail(focusedTask.id)
    onClose()
  }, [focusedTask, onNavigateToDetail, onClose])

  const handleMoveToProject = useCallback(() => {
    if (!focusedTask || !onMoveToProject) return
    onMoveToProject(focusedTask.id)
    onClose()
  }, [focusedTask, onMoveToProject, onClose])

  const handleDelete = useCallback(() => {
    if (focusedTask && onDelete) {
      onDelete(focusedTask.id)
      onClose()
    }
  }, [focusedTask, onDelete, onClose])

  const handleRruleChange = useCallback(
    (rrule: string | null, recurrenceMode?: 'from_due' | 'from_completion') => {
      if (!focusedTask || !onRruleChange) return
      onRruleChange(focusedTask.id, rrule, recurrenceMode)
    },
    [focusedTask, onRruleChange],
  )

  // Handle dialog/sheet close - reset pending date
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        setPendingDate(null)
        onClose()
      }
    },
    [onClose],
  )

  if (!focusedTask) return null

  const panel = (
    <QuickActionPanel
      task={focusedTask}
      timezone={timezone}
      mode={isMobile ? 'sheet' : 'popover'}
      onDateChange={handleDateChange}
      onPriorityChange={onPriorityChange ? handlePriorityChange : undefined}
      onRruleChange={onRruleChange ? handleRruleChange : undefined}
      onDelete={onDelete ? handleDelete : undefined}
      onNavigateToDetail={onNavigateToDetail ? handleNavigateToDetail : undefined}
      onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
      onSave={handleSave}
      onCancel={handleCancel}
    />
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton>
          <SheetHeader>
            <SheetTitle>Quick Actions</SheetTitle>
            <SheetDescription className="sr-only">
              Adjust date, priority, and other task settings
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{panel}</div>
          <div className="h-6 sm:hidden" />
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
