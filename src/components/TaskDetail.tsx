'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format-date'
import { useTimezone } from '@/hooks/useTimezone'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { LabelPicker } from '@/components/LabelPicker'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { getPriorityOption } from '@/lib/priority'
import type { Task, Note, Project } from '@/types'
import { formatRRule } from '@/lib/format-rrule'

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
}: TaskDetailProps) {
  const timezone = useTimezone()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)

  const handleTitleSave = () => {
    if (titleDraft.trim() && titleDraft.trim() !== task.title) {
      onFieldChange?.('title', titleDraft.trim())
    }
    setEditingTitle(false)
  }

  return (
    <div className="space-y-6">
      <TitleSection
        task={task}
        editable={editable}
        editingTitle={editingTitle}
        titleDraft={titleDraft}
        onTitleDraftChange={setTitleDraft}
        onTitleSave={handleTitleSave}
        onEditTitle={() => {
          setTitleDraft(task.title)
          setEditingTitle(true)
        }}
        onDelete={onDelete}
      />

      <TaskFields
        task={task}
        project={project}
        projects={projects}
        editable={editable}
        onFieldChange={onFieldChange}
        onSnooze={onSnooze}
        onDelete={onDelete}
        timezone={timezone}
      />

      <NotesSection
        notes={notes}
        editable={editable}
        onAddNote={onAddNote}
        onDeleteNote={onDeleteNote}
        timezone={timezone}
      />
    </div>
  )
}

function TitleSection({
  task,
  editable,
  editingTitle,
  titleDraft,
  onTitleDraftChange,
  onTitleSave,
  onEditTitle,
  onDelete,
}: {
  task: Task
  editable: boolean
  editingTitle: boolean
  titleDraft: string
  onTitleDraftChange: (v: string) => void
  onTitleSave: () => void
  onEditTitle: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        {editable && editingTitle ? (
          <Input
            type="text"
            value={titleDraft}
            onChange={(e) => onTitleDraftChange(e.target.value)}
            onBlur={onTitleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onTitleSave()
            }}
            className="h-auto py-1 text-2xl font-semibold"
            autoFocus
          />
        ) : (
          <h1
            className={cn(
              'text-2xl font-semibold',
              editable && 'hover:text-primary cursor-pointer transition-colors',
            )}
            onClick={() => editable && onEditTitle()}
          >
            {task.title}
          </h1>
        )}
        {task.done && (
          <Badge
            variant="secondary"
            className="mt-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          >
            Completed
          </Badge>
        )}
      </div>

      {editable && onDelete && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete task"
        >
          <Trash2 className="size-5" />
        </Button>
      )}
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
  timezone,
}: {
  task: Task
  project?: Project
  projects: Project[]
  editable: boolean
  onFieldChange?: (field: string, value: unknown) => void
  onSnooze?: (until: string) => void
  onDelete?: () => void
  timezone: string
}) {
  const currentRruleRef = useRef(task.rrule)
  useEffect(() => {
    currentRruleRef.current = task.rrule
  }, [task.rrule])
  const isOverdue = task.due_at && new Date(task.due_at) < new Date()
  const priority = getPriorityOption(task.priority)

  const handleRruleChange = useCallback(
    (value: string | null) => {
      if (value === currentRruleRef.current) return
      onFieldChange?.('rrule', value)
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

  const handleMoveToProject = useCallback(() => {
    // Cycle to next project (simple approach for inline mode)
    if (projects.length < 2) return
    const currentIdx = projects.findIndex((p) => p.id === task.project_id)
    const nextIdx = (currentIdx + 1) % projects.length
    onFieldChange?.('project_id', projects[nextIdx].id)
  }, [projects, task.project_id, onFieldChange])

  return (
    <div className="space-y-4">
      {/* Quick Action Panel — positioned above notes for mobile thumb reach */}
      {editable && (
        <div className="rounded-lg border p-3">
          <QuickActionPanel
            task={task}
            timezone={timezone}
            mode="inline"
            onDateChange={handleDateChange}
            onPriorityChange={handlePriorityChange}
            onRruleChange={handleRruleChange}
            onMoveToProject={projects.length > 1 ? handleMoveToProject : undefined}
            onDelete={onDelete}
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

      <DetailField label="Project">
        {editable && projects.length > 0 ? (
          <Select
            value={task.project_id.toString()}
            onValueChange={(value) => onFieldChange?.('project_id', parseInt(value))}
          >
            <SelectTrigger className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id.toString()}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{project?.name || 'Unknown'}</span>
        )}
      </DetailField>

      <DetailField label="Labels">
        {editable ? (
          <LabelPicker
            labels={task.labels}
            onChange={(labels) => onFieldChange?.('labels', labels)}
          />
        ) : task.labels.length > 0 ? (
          <ColoredLabels labels={task.labels} />
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </DetailField>

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

      {task.snoozed_from && (
        <DetailField label="Snoozed">
          <span className="text-blue-500">
            Originally due {formatDateTime(task.snoozed_from, timezone)}
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
