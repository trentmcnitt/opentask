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
import { useEditorHost } from '@/hooks/useEditorHost'
import { showErrorToast, showSuccessToast, showSuccessToastWithAction } from '@/lib/toast'
import { DirtyCard } from '@/components/DirtyCard'
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

/** The POST body for a new task: only the fields the user actually set. */
function buildCreateBody(fields: QuickActionPanelChanges & { title: string }) {
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
  return body
}

/**
 * Create the task. A failure toasts the server's reason (e.g. a label that
 * isn't in the registry) and rejects, so the panel keeps the title and the
 * staged fields for a retry instead of wiping them as if the create had worked.
 */
async function postTask(
  body: Record<string, unknown>,
): Promise<{ id?: number; title: string; labels?: string[] } | undefined> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as {
      data?: { id?: number; title: string; labels?: string[] }
      error?: string
    } | null
    if (!res.ok) throw new Error(json?.error || 'Failed to create task')
    return json?.data
  } catch (err) {
    showErrorToast(err instanceof Error && err.message ? err.message : 'Failed to create task')
    throw err
  }
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
          <AlertDialogAction variant="outline" onClick={onDiscard}>
            Discard
          </AlertDialogAction>
          <AlertDialogCancel variant="default">Keep Editing</AlertDialogCancel>
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
  // `isDirty` paints the stripe and locks the sheet's drag; the dismiss guard
  // reads `dirtyRef`, current the moment the panel reports (see useEditorHost).
  const { isDirty: isPanelDirty, dirtyRef, onDirtyChange } = useEditorHost()
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)

  const handleCreate = useCallback(
    async (fields: QuickActionPanelChanges & { title: string }) => {
      const createdTask = await postTask(buildCreateBody(fields))

      onCreated()

      // Show success toast with navigation action
      if (createdTask?.id) {
        const id = createdTask.id
        showSuccessToastWithAction(
          'Task added',
          { label: 'View', onClick: () => router.push(`/tasks/${id}`) },
          { id: `task-created-${id}` },
        )
      }

      // If the task has ai-to-process, start polling for enrichment result
      if (createdTask?.id && createdTask.labels?.includes('ai-to-process')) {
        pollForEnrichment(createdTask.id, createdTask.title, onCreated)
      }
    },
    [onCreated, router],
  )

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        if (dirtyRef.current) {
          setShowDiscardConfirm(true)
        } else {
          onClose()
        }
      }
    },
    [onClose, dirtyRef],
  )

  const panel = (
    <DirtyCard ref={panelRef} dirty={isPanelDirty}>
      <QuickActionPanel
        task={null}
        timezone={timezone}
        mode={isMobile ? 'sheet' : 'popover'}
        createMode
        initialTitle={initialTitle}
        onCreate={handleCreate}
        projects={projects as Project[]}
        onCancel={handleCancel}
        onDirtyChange={onDirtyChange}
      />
    </DirtyCard>
  )

  const handleDiscard = useCallback(() => {
    setShowDiscardConfirm(false)
    onClose()
  }, [onClose])

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl"
            showCloseButton={false}
            draggable={!isPanelDirty}
          >
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
