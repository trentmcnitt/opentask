'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
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
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { showErrorToast, showSuccessToast, showSuccessToastWithAction } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { Project } from '@/types'

/**
 * Poll for AI enrichment result after task creation.
 *
 * Checks every 2 seconds (max 15 attempts / 30 seconds) for the ai-to-process
 * label to disappear. Shows a toast describing what changed on success, an
 * error toast on failure, or stops silently on timeout.
 */
function pollForEnrichment(taskId: number, originalTitle: string, onRefresh: () => void): void {
  let attempts = 0
  const maxAttempts = 15
  const intervalMs = 2000

  const timer = setInterval(async () => {
    attempts++
    try {
      const res = await fetch(`/api/tasks/${taskId}`)
      if (!res.ok) {
        clearInterval(timer)
        return
      }
      const json = await res.json()
      const task = json.data
      if (!task) {
        clearInterval(timer)
        return
      }

      const labels: string[] = task.labels ?? []

      // ai-failed appeared — enrichment failed permanently
      if (labels.includes('ai-failed')) {
        clearInterval(timer)
        showErrorToast(`AI enrichment failed for "${originalTitle}"`)
        onRefresh()
        return
      }

      // ai-to-process gone — enrichment succeeded
      if (!labels.includes('ai-to-process')) {
        clearInterval(timer)
        const description = buildEnrichmentToast(task, originalTitle)
        if (description) {
          showSuccessToast(description)
        }
        onRefresh()
        return
      }

      // Still processing — check timeout
      if (attempts >= maxAttempts) {
        clearInterval(timer)
        // Stop silently — cron will handle it
      }
    } catch {
      clearInterval(timer)
    }
  }, intervalMs)
}

/** Build a human-readable toast describing what the AI enrichment changed. */
function buildEnrichmentToast(
  task: {
    title: string
    due_at: string | null
    priority: number
    labels: string[]
    rrule: string | null
    project_id: number
  },
  originalTitle: string,
): string | null {
  const changes: string[] = []

  if (task.title !== originalTitle) {
    changes.push(`title → "${task.title}"`)
  }
  if (task.due_at) {
    changes.push('due date set')
  }
  if (task.priority > 0) {
    const names: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' }
    changes.push(`priority ${names[task.priority] ?? task.priority}`)
  }
  if (task.rrule) {
    changes.push('recurrence set')
  }
  const userLabels = task.labels.filter((l) => !l.startsWith('ai-'))
  if (userLabels.length > 0) {
    changes.push(`+${userLabels.join(', +')}`)
  }

  if (changes.length === 0) {
    return 'AI processed — no changes needed'
  }

  return `AI enriched: ${changes.join(', ')}`
}

function DiscardConfirmDialog({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDiscard: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard new task?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes that will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep Editing</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={onDiscard}>
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

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
  const router = useRouter()
  const timezone = useTimezone()
  const isMobile = useIsMobile()
  const [isPanelDirty, setIsPanelDirty] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

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
      if (fields.notes !== undefined && fields.notes !== null) {
        body.notes = fields.notes
      }

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to create task')
        const json = await res.json()
        const createdTask = json.data

        onCreated()

        // Show success toast with navigation action
        if (createdTask?.id) {
          showSuccessToastWithAction(
            'Task added',
            { label: 'View', onClick: () => router.push(`/tasks/${createdTask.id}`) },
            { id: `task-created-${createdTask.id}` },
          )
        }

        // If the task has ai-to-process, start polling for enrichment result
        if (createdTask?.labels?.includes('ai-to-process')) {
          pollForEnrichment(createdTask.id, createdTask.title, onCreated)
        }
      } catch {
        showErrorToast('Failed to create task')
      }
    },
    [onCreated, router],
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
      if (!newOpen) {
        if (isPanelDirty) {
          setShowDiscardConfirm(true)
        } else {
          onClose()
        }
      }
    },
    [onClose, isPanelDirty],
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

  const handleDiscard = useCallback(() => {
    setShowDiscardConfirm(false)
    onClose()
  }, [onClose])

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
            <VisuallyHidden>
              <SheetTitle>New Task</SheetTitle>
              <SheetDescription>Create a new task</SheetDescription>
            </VisuallyHidden>
            <div className="px-4 pb-2">{panel}</div>
          </SheetContent>
        </Sheet>
        <DiscardConfirmDialog
          open={showDiscardConfirm}
          onOpenChange={setShowDiscardConfirm}
          onDiscard={handleDiscard}
        />
      </>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
          <VisuallyHidden>
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription>Create a new task</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{panel}</div>
        </DialogContent>
      </Dialog>
      <DiscardConfirmDialog
        open={showDiscardConfirm}
        onOpenChange={setShowDiscardConfirm}
        onDiscard={handleDiscard}
      />
    </>
  )
}
