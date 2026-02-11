'use client'

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { QuickActionPanel, type QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { getPriorityOption } from '@/lib/priority'
import type { Task, Project } from '@/types'
import { formatRRule } from '@/lib/format-rrule'
import { Textarea } from '@/components/ui/textarea'
import { Pencil } from 'lucide-react'

interface TaskDetailProps {
  task: Task
  project?: Project
  projects?: Project[]
  editable?: boolean
  onDelete?: () => void
  onMarkDone?: () => void
  /** Called when QuickActionPanel dirty state changes (for navigation protection) */
  onDirtyChange?: (isDirty: boolean) => void
  /** Called when notes is saved */
  onNotesSave?: (value: string | null) => void
  /** Ref populated with save function for external triggering (e.g., from navigation dialog) */
  saveRef?: React.MutableRefObject<(() => Promise<void> | void) | null>
  /**
   * Batched save handler: receives all changed fields and saves them in one request.
   * This creates a single undo entry instead of multiple entries for each field change.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void
  /** AI annotation text to display in the QuickActionPanel */
  annotation?: string
}

export function TaskDetail({
  task,
  project,
  projects = [],
  editable = false,
  onDelete,
  onMarkDone,
  onDirtyChange,
  onNotesSave,
  saveRef,
  onSaveAll,
  annotation,
}: TaskDetailProps) {
  const timezone = useTimezone()

  // Track dirty state locally for border indicator, while also propagating to parent
  const [isDirty, setIsDirty] = useState(false)
  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setIsDirty(dirty)
      onDirtyChange?.(dirty)
    },
    [onDirtyChange],
  )

  const isOverdue = task.due_at && new Date(task.due_at) < new Date()
  const priority = getPriorityOption(task.priority)

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Quick Action Panel — title, date/time grid, and actions */}
        {editable && onSaveAll && (
          <div
            className={cn(
              'rounded-lg border p-3',
              isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
            )}
          >
            <QuickActionPanel
              key={task.updated_at}
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
              onSave={() => {}}
              onCancel={() => {}}
              onDirtyChange={handleDirtyChange}
              saveRef={saveRef}
              annotation={annotation}
            />
          </div>
        )}

        {/* Read-only due date display */}
        {!editable && (
          <DetailField label="Due">
            <span className={cn(isOverdue && 'text-destructive font-medium')}>
              {task.due_at ? (
                formatDateTime(task.due_at, timezone)
              ) : (
                <span className="text-muted-foreground">No due date</span>
              )}
            </span>
          </DetailField>
        )}

        {/* Priority (read-only — editing via QuickActionPanel More menu) */}
        {!editable && (
          <DetailField label="Priority">
            <span className={priority.color}>{priority.label}</span>
          </DetailField>
        )}

        {/* Project - only show in read-only mode (editable mode uses QuickActionPanel) */}
        {!editable && (
          <DetailField label="Project">
            <span>{project?.name || 'Unknown'}</span>
          </DetailField>
        )}

        {/* Labels - only show in read-only mode (editable mode uses QuickActionPanel) */}
        {!editable && (
          <DetailField label="Labels">
            {task.labels.length > 0 ? (
              <ColoredLabels labels={task.labels} />
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </DetailField>
        )}

        {/* Recurrence - read-only (editing via QuickActionPanel) */}
        {!editable && (
          <DetailField label="Recurrence">
            {task.rrule ? (
              <>
                {formatRRule(task.rrule, task.anchor_time)}
                <span className="text-muted-foreground ml-2 text-sm">
                  (
                  {task.recurrence_mode === 'from_completion' ? 'from completion' : 'from due date'}
                  )
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </DetailField>
        )}

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

      <NotesSection notes={task.notes} onSave={onNotesSave} />
    </div>
  )
}

/**
 * NotesSection displays notes with an edit toggle.
 * The section is always visible and the edit button is independent of the page's editable state.
 * This allows users to view and modify notes at any time.
 */
function NotesSection({
  notes,
  onSave,
}: {
  notes: string | null
  onSave?: (value: string | null) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(notes ?? '')

  const handleStartEdit = () => {
    setDraft(notes ?? '') // Initialize draft with current value when entering edit mode
    setIsEditing(true)
  }

  const handleSave = () => {
    const trimmed = draft.trim()
    onSave?.(trimmed || null) // Save null if empty
    setIsEditing(false)
  }

  const handleCancel = () => {
    setIsEditing(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
          Notes
        </h2>
        {!isEditing && onSave && (
          <Button variant="ghost" size="sm" onClick={handleStartEdit} className="h-7 w-7 p-0">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add notes..."
            className="min-h-[100px]"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : notes ? (
        <div className="bg-muted/50 rounded-md p-3 text-sm whitespace-pre-wrap">{notes}</div>
      ) : (
        <p className="text-muted-foreground text-sm italic">No notes</p>
      )}
    </div>
  )
}

function ColoredLabels({ labels }: { labels: string[] }) {
  const { labelConfig } = useLabelConfig()
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => {
        const colorClasses = getLabelClasses(label, labelConfig)
        return (
          <Badge
            key={label}
            variant={colorClasses ? undefined : 'secondary'}
            className={colorClasses ? `${colorClasses} border-0` : undefined}
          >
            {label}
          </Badge>
        )
      })}
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
