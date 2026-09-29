'use client'

import { formatDateTime } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import { DirtyCard } from '@/components/DirtyCard'
import { QuickActionPanel, type QuickActionPanelChanges } from '@/components/QuickActionPanel'
import type { Task, Project } from '@/types'

interface TaskDetailProps {
  task: Task
  project?: Project
  projects?: Project[]
  onDelete?: () => void
  onMarkDone?: () => void
  /**
   * Whether the editor holds unsaved edits, as the host last heard through
   * `onDirtyChange`. The host owns the dirty state (it also guards navigation
   * with it); this only paints the stripe. The card wraps the editor alone,
   * not the Created/Updated rows below it, so it is drawn here rather than by
   * the page as for the Quota and Reminder editors.
   */
  dirty: boolean
  /** Called when QuickActionPanel dirty state changes (for navigation protection) */
  onDirtyChange?: (isDirty: boolean) => void
  /** Ref populated with save function for external triggering (e.g., from navigation dialog) */
  saveRef?: React.MutableRefObject<(() => Promise<void> | void) | null>
  /**
   * Batched save handler: receives all changed fields and saves them in one request.
   * This creates a single undo entry instead of multiple entries for each field change.
   */
  onSaveAll: (changes: QuickActionPanelChanges) => Promise<void>
  /** AI annotation text to display in the QuickActionPanel */
  annotation?: string
  /** AI Insights commentary text to display in the QuickActionPanel */
  insightsCommentary?: string
}

export function TaskDetail({
  task,
  project,
  projects = [],
  onDelete,
  onMarkDone,
  dirty,
  onDirtyChange,
  saveRef,
  onSaveAll,
  annotation,
  insightsCommentary,
}: TaskDetailProps) {
  const timezone = useTimezone()

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Quick Action Panel — title, date/time grid, and actions */}
        <DirtyCard dirty={dirty}>
          <QuickActionPanel
            key={task.id}
            task={task}
            timezone={timezone}
            mode="popover"
            titleVariant="prominent"
            showCompletedBadge
            projectName={project?.name}
            projects={projects}
            onSaveAll={onSaveAll}
            onDelete={onDelete}
            onMarkDone={onMarkDone}
            onDirtyChange={onDirtyChange}
            saveRef={saveRef}
            annotation={annotation}
            insightsCommentary={insightsCommentary}
          />
        </DirtyCard>

        {/* Only show "Snoozed" for recurring tasks - for one-offs, it's just a due date change */}
        {task.original_due_at && task.rrule && (
          <DetailField label="Snoozed">
            <span className="text-blue-500">
              Originally due {formatDateTime(task.original_due_at, timezone)}
            </span>
          </DetailField>
        )}

        <DetailField label="Created">{formatDateTime(task.created_at, timezone)}</DetailField>

        {task.updated_at !== task.created_at && (
          <DetailField label="Updated">{formatDateTime(task.updated_at, timezone)}</DetailField>
        )}
      </div>
    </div>
  )
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="text-muted-foreground w-24 flex-shrink-0 pt-0.5 text-sm">{label}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  )
}
