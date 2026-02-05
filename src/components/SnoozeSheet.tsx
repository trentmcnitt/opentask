'use client'

import { useState, useCallback, useRef } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface SnoozeSheetProps {
  task: Task
  onSnooze: (until: string) => void
  onClose: () => void
}

export function SnoozeSheet({ task, onSnooze, onClose }: SnoozeSheetProps) {
  const timezone = useTimezone()
  const [open, setOpen] = useState(true)
  const pendingDateRef = useRef<string | null>(null)
  const [isPanelDirty, setIsPanelDirty] = useState(false)

  const handleDateChange = useCallback((isoUtc: string) => {
    pendingDateRef.current = isoUtc
  }, [])

  const handleSave = useCallback(() => {
    if (pendingDateRef.current) {
      onSnooze(pendingDateRef.current)
    }
    onClose()
  }, [onSnooze, onClose])

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(newOpen)
      if (!newOpen) {
        onClose()
      }
    },
    [onClose],
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton>
        <SheetHeader>
          <SheetTitle>Snooze</SheetTitle>
          <SheetDescription className="sr-only">Adjust the due date for this task</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <div
            className={cn(
              'rounded-lg border p-3',
              isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
            )}
          >
            <QuickActionPanel
              task={task}
              timezone={timezone}
              mode="sheet"
              onDateChange={handleDateChange}
              onSave={handleSave}
              onCancel={handleCancel}
              onDirtyChange={setIsPanelDirty}
            />
          </div>
        </div>
        <div className="h-6 sm:hidden" />
      </SheetContent>
    </Sheet>
  )
}
