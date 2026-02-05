'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { QuickActionPanel, type QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { showToast } from '@/lib/toast'
import { getPriorityOption } from '@/lib/priority'
import type { Task, Note, Project } from '@/types'
import { formatRRule } from '@/lib/format-rrule'
import { Textarea } from '@/components/ui/textarea'
import { Pencil } from 'lucide-react'

interface TaskDetailProps {
  task: Task
  notes: Note[]
  project?: Project
  projects?: Project[]
  editable?: boolean
  onFieldChange?: (field: string, value: unknown) => void
  onSnooze?: (until: string) => void
  onAddNote?: (content: string) => void
  onDeleteNote?: (noteId: number) => void
  onDelete?: () => void
  onMarkDone?: () => void
  /** Called when QuickActionPanel dirty state changes (for navigation protection) */
  onDirtyChange?: (isDirty: boolean) => void
  /** Called when meta_notes is saved */
  onMetaNotesSave?: (value: string | null) => void
  /** Ref populated with save function for external triggering (e.g., from navigation dialog) */
  saveRef?: React.MutableRefObject<(() => void) | null>
  /**
   * Batched save handler: receives all changed fields and saves them in one request.
   * This creates a single undo entry instead of multiple entries for each field change.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void
}

export function TaskDetail({
  task,
  notes,
  project,
  projects = [],
  editable = false,
  onFieldChange,
  onSnooze,
  onAddNote,
  onDeleteNote,
  onDelete,
  onMarkDone,
  onDirtyChange,
  onMetaNotesSave,
  saveRef,
  onSaveAll,
}: TaskDetailProps) {
  const timezone = useTimezone()

  return (
    <div className="space-y-6">
      <TaskFields
        task={task}
        project={project}
        projects={projects}
        editable={editable}
        onFieldChange={onFieldChange}
        onSnooze={onSnooze}
        onDelete={onDelete}
        onMarkDone={onMarkDone}
        onDirtyChange={onDirtyChange}
        saveRef={saveRef}
        timezone={timezone}
        onSaveAll={onSaveAll}
      />

      <NotesSection
        notes={notes}
        editable={editable}
        onAddNote={onAddNote}
        onDeleteNote={onDeleteNote}
        timezone={timezone}
      />

      <MetaNotesSection metaNotes={task.meta_notes} onSave={onMetaNotesSave} />
    </div>
  )
}

function TaskFields({
  task,
  project,
  projects,
  editable,
  onFieldChange,
  onSnooze,
  onDelete,
  onMarkDone,
  onDirtyChange,
  saveRef,
  timezone,
  onSaveAll,
}: {
  task: Task
  project?: Project
  projects: Project[]
  editable: boolean
  onFieldChange?: (field: string, value: unknown) => void
  onSnooze?: (until: string) => void
  onDelete?: () => void
  onMarkDone?: () => void
  onDirtyChange?: (isDirty: boolean) => void
  saveRef?: React.MutableRefObject<(() => void) | null>
  timezone: string
  onSaveAll?: (changes: QuickActionPanelChanges) => void
}) {
  // Track dirty state locally for border indicator, while also propagating to parent
  const [isDirty, setIsDirty] = useState(false)
  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setIsDirty(dirty)
      onDirtyChange?.(dirty)
    },
    [onDirtyChange],
  )

  const currentRruleRef = useRef(task.rrule)
  useEffect(() => {
    currentRruleRef.current = task.rrule
  }, [task.rrule])
  const isOverdue = task.due_at && new Date(task.due_at) < new Date()
  const priority = getPriorityOption(task.priority)

  const handleRruleChange = useCallback(
    (value: string | null, recurrenceMode?: 'from_due' | 'from_completion') => {
      // Only update fields that actually changed
      if (value !== currentRruleRef.current) {
        onFieldChange?.('rrule', value)
      }
      if (recurrenceMode) {
        onFieldChange?.('recurrence_mode', recurrenceMode)
      }
    },
    [onFieldChange],
  )

  const handleDateChange = useCallback(
    (isoUtc: string) => {
      // Use snooze endpoint if task already has a due_at, PATCH otherwise
      if (task.due_at && onSnooze) {
        onSnooze(isoUtc)
      } else {
        onFieldChange?.('due_at', isoUtc)
      }
    },
    [task.due_at, onSnooze, onFieldChange],
  )

  const handlePriorityChange = useCallback(
    (newPriority: number) => {
      if (newPriority !== task.priority) {
        onFieldChange?.('priority', newPriority)
      }
    },
    [task.priority, onFieldChange],
  )

  const handleProjectChange = useCallback(
    (projectId: number) => {
      if (projectId !== task.project_id) {
        onFieldChange?.('project_id', projectId)
      }
    },
    [task.project_id, onFieldChange],
  )

  const handleLabelsChange = useCallback(
    (labels: string[]) => {
      onFieldChange?.('labels', labels)
    },
    [onFieldChange],
  )

  const handleTitleChange = useCallback(
    (title: string) => {
      onFieldChange?.('title', title)
    },
    [onFieldChange],
  )

  /**
   * Batched save handler wrapper: delegates to parent's onSaveAll and shows toast.
   * The actual PATCH request is handled by the page component.
   */
  const handleSaveAllWrapper = useCallback(
    (changes: QuickActionPanelChanges) => {
      onSaveAll?.(changes)
      showToast({ message: 'Changes saved' })
    },
    [onSaveAll],
  )

  const handleCancel = useCallback(() => {
    // Reset is handled internally by QuickActionPanel
  }, [])

  return (
    <div className="space-y-4">
      {/* Quick Action Panel — title, date/time grid, and actions */}
      {editable && (
        <div
          className={cn(
            'rounded-lg border p-3',
            isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
          )}
        >
          <QuickActionPanel
            task={task}
            timezone={timezone}
            mode="popover"
            titleVariant="prominent"
            showCompletedBadge
            projectName={project?.name}
            projects={projects}
            onDateChange={handleDateChange}
            onSaveAll={onSaveAll ? handleSaveAllWrapper : undefined}
            onPriorityChange={onSaveAll ? undefined : handlePriorityChange}
            onRruleChange={onSaveAll ? undefined : handleRruleChange}
            onProjectChange={
              onSaveAll ? undefined : projects.length > 0 ? handleProjectChange : undefined
            }
            onLabelsChange={onSaveAll ? undefined : handleLabelsChange}
            onTitleChange={onSaveAll ? undefined : handleTitleChange}
            onDelete={onDelete}
            onMarkDone={onMarkDone}
            onSave={() => {}}
            onCancel={handleCancel}
            onDirtyChange={handleDirtyChange}
            saveRef={saveRef}
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
                ({task.recurrence_mode === 'from_completion' ? 'from completion' : 'from due date'})
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
  )
}

/**
 * MetaNotesSection displays AI-generated notes with its own edit toggle.
 * The section is always visible and the edit button is independent of the page's editable state.
 * This allows users to view and modify AI notes at any time.
 */
function MetaNotesSection({
  metaNotes,
  onSave,
}: {
  metaNotes: string | null
  onSave?: (value: string | null) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(metaNotes ?? '')

  const handleStartEdit = () => {
    setDraft(metaNotes ?? '') // Initialize draft with current value when entering edit mode
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
          AI Notes
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
            placeholder="Add AI-generated notes..."
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
      ) : metaNotes ? (
        <div className="bg-muted/50 rounded-md p-3 text-sm whitespace-pre-wrap">{metaNotes}</div>
      ) : (
        <p className="text-muted-foreground text-sm italic">No AI notes</p>
      )}
    </div>
  )
}

function NotesSection({
  notes,
  editable,
  onAddNote,
  onDeleteNote,
  timezone,
}: {
  notes: Note[]
  editable: boolean
  onAddNote?: (content: string) => void
  onDeleteNote?: (noteId: number) => void
  timezone: string
}) {
  const [newNote, setNewNote] = useState('')

  const handleAddNote = () => {
    if (newNote.trim()) {
      onAddNote?.(newNote.trim())
      setNewNote('')
    }
  }

  return (
    <div>
      <h2 className="text-muted-foreground mb-3 text-sm font-semibold tracking-wider uppercase">
        Notes
        <span className="text-muted-foreground/60 ml-2">{notes.length}</span>
      </h2>

      {editable && onAddNote && (
        <div className="mb-4 flex gap-2">
          <Input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddNote()
            }}
            placeholder="Add a note..."
            className="flex-1"
          />
          <Button onClick={handleAddNote} disabled={!newNote.trim()}>
            Add
          </Button>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No notes yet.</p>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <div key={note.id} className="group bg-muted rounded-lg border p-3">
              <p className="text-sm whitespace-pre-wrap">{note.content}</p>
              <div className="mt-2 flex items-center justify-between">
                <p className="text-muted-foreground text-xs">
                  {formatDateTime(note.created_at, timezone)}
                </p>
                {editable && onDeleteNote && (
                  <button
                    onClick={() => onDeleteNote(note.id)}
                    className="text-muted-foreground hover:text-destructive text-xs opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
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
