'use client'

import { useState, useCallback } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'

interface SelectionActionSheetProps {
  selectedCount: number
  onDone: () => void
  onSnooze: (until: string) => void
  onDelete: () => void
  onPriorityChange: (delta: 1 | -1) => void
  onMoveToProject?: () => void
  onClear: () => void
}

export function SelectionActionSheet({
  selectedCount,
  onDone,
  onSnooze,
  onDelete,
  onPriorityChange,
  onMoveToProject,
  onClear,
}: SelectionActionSheetProps) {
  const timezone = useTimezone()
  const [sheetOpen, setSheetOpen] = useState(false)

  const handleDateChange = useCallback(
    (isoUtc: string) => {
      onSnooze(isoUtc)
      setSheetOpen(false)
    },
    [onSnooze],
  )

  const handleDelete = useCallback(() => {
    onDelete()
    setSheetOpen(false)
  }, [onDelete])

  const handleDone = useCallback(() => {
    onDone()
    setSheetOpen(false)
  }, [onDone])

  const handleMoveToProject = useCallback(() => {
    onMoveToProject?.()
    setSheetOpen(false)
  }, [onMoveToProject])

  if (selectedCount === 0) return null

  return (
    <>
      {/* Floating trigger button */}
      <div className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6">
        <div
          className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
          aria-live="polite"
        >
          <span className="mr-2 text-sm font-medium">{selectedCount} selected</span>

          <Button
            size="sm"
            variant="secondary"
            onClick={handleDone}
            className="bg-green-600 text-white hover:bg-green-700"
          >
            <Check className="mr-1 size-4" />
            Done
          </Button>

          <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
            More
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            aria-label="Clear selection"
            className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 ml-2"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Full action sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton>
          <SheetHeader>
            <SheetTitle>{selectedCount} tasks selected</SheetTitle>
            <SheetDescription className="sr-only">
              Adjust date, priority, and other settings for selected tasks
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <QuickActionPanel
              task={null}
              selectedCount={selectedCount}
              timezone={timezone}
              mode="sheet"
              open={sheetOpen}
              onDateChange={handleDateChange}
              onPriorityChange={onPriorityChange}
              onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
              onDelete={handleDelete}
              hideRecurrence
            />
          </div>
          <div className="h-6 sm:hidden" />
        </SheetContent>
      </Sheet>
    </>
  )
}
