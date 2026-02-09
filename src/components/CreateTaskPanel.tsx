'use client'

import { useCallback, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { showErrorToast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { Project } from '@/types'

interface CreateTaskPanelProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  projects: { id: number; name: string }[]
  initialTitle?: string
}

export function CreateTaskPanel({
  open,
  onClose,
  onCreated,
  projects,
  initialTitle,
}: CreateTaskPanelProps) {
  const timezone = useTimezone()
  const isMobile = useIsMobile()
  const [isPanelDirty, setIsPanelDirty] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)

  const handleCreate = useCallback(
    async (fields: QuickActionPanelChanges & { title: string }) => {
      const body: Record<string, unknown> = { title: fields.title }
      if (fields.due_at) body.due_at = fields.due_at
      if (fields.priority && fields.priority > 0) body.priority = fields.priority
      if (fields.labels && fields.labels.length > 0) body.labels = fields.labels
      if (fields.rrule) {
        body.rrule = fields.rrule
        if (fields.recurrence_mode) body.recurrence_mode = fields.recurrence_mode
      }
      if (fields.project_id) body.project_id = fields.project_id
      if (fields.auto_snooze_minutes !== undefined && fields.auto_snooze_minutes !== null) {
        body.auto_snooze_minutes = fields.auto_snooze_minutes
      }

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to create task')
        onCreated()
      } catch {
        showErrorToast('Failed to create task')
      }
    },
    [onCreated],
  )

  const handleSave = useCallback(() => {
    // In create mode, Save is replaced by Create Task — this is the onSave callback
    // that QuickActionPanel calls after handleCreate completes
    onClose()
  }, [onClose])

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) onClose()
    },
    [onClose],
  )

  const panel = (
    <div
      ref={panelRef}
      className={cn(
        'rounded-lg border p-3',
        isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <QuickActionPanel
        task={null}
        timezone={timezone}
        mode={isMobile ? 'sheet' : 'popover'}
        createMode
        initialTitle={initialTitle}
        onCreate={handleCreate}
        projects={projects as Project[]}
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
          <VisuallyHidden>
            <SheetTitle>New Task</SheetTitle>
            <SheetDescription>Create a new task</SheetDescription>
          </VisuallyHidden>
          <div className="px-4 pb-2">{panel}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
        <VisuallyHidden>
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>Create a new task</DialogDescription>
        </VisuallyHidden>
        <div className="min-w-0">{panel}</div>
      </DialogContent>
    </Dialog>
  )
}
