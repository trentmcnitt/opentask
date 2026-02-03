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
  /** Called on priority change */
  onPriorityChange?: (taskId: number, newPriority: number) => void
  /** Called to delete task */
  onDelete?: (taskId: number) => void
}

export function QuickActionPopover({
  focusedTask,
  open,
  onClose,
  onDateSave,
  onPriorityChange,
  onDelete,
}: QuickActionPopoverProps) {
  const timezone = useTimezone()
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const handleDateChange = useCallback(
    (isoUtc: string) => {
      if (focusedTask) {
        onDateSave(focusedTask.id, isoUtc)
      }
      onClose()
    },
    [focusedTask, onDateSave, onClose],
  )

  const handlePriorityChange = useCallback(
    (delta: 1 | -1) => {
      if (!focusedTask || !onPriorityChange) return
      const current = focusedTask.priority || 0
      const next = Math.max(0, Math.min(4, current + delta))
      if (next !== current) {
        onPriorityChange(focusedTask.id, next)
      }
    },
    [focusedTask, onPriorityChange],
  )

  const handleDelete = useCallback(() => {
    if (focusedTask && onDelete) {
      onDelete(focusedTask.id)
      onClose()
    }
  }, [focusedTask, onDelete, onClose])

  if (!focusedTask) return null

  const panel = (
    <QuickActionPanel
      task={focusedTask}
      timezone={timezone}
      mode={isMobile ? 'sheet' : 'popover'}
      open={open}
      onDateChange={handleDateChange}
      onPriorityChange={handlePriorityChange}
      onDelete={onDelete ? handleDelete : undefined}
    />
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
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
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-96 max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
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
