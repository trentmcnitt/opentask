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
          <QuickActionPanel
            task={task}
            timezone={timezone}
            mode="sheet"
            onDateChange={handleDateChange}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
        <div className="h-6 sm:hidden" />
      </SheetContent>
    </Sheet>
  )
}
