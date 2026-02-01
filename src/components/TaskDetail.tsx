'use client'

import { useState } from 'react'
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
import type { Task, Note, Project } from '@/types'
import { formatRRule } from '@/lib/format-rrule'

interface TaskDetailProps {
  task: Task
  notes: Note[]
  project?: Project
  projects?: Project[]
  editable?: boolean
  onFieldChange?: (field: string, value: unknown) => void
  onAddNote?: (content: string) => void
  onDeleteNote?: (noteId: number) => void
  onDelete?: () => void
}

const PRIORITY_OPTIONS = [
  { value: 0, label: 'None', color: 'text-muted-foreground' },
  { value: 1, label: 'Low', color: 'text-blue-500' },
  { value: 2, label: 'Medium', color: 'text-yellow-500' },
  { value: 3, label: 'High', color: 'text-orange-500' },
  { value: 4, label: 'Urgent', color: 'text-red-500' },
]

export function TaskDetail({
  task,
  notes,
  project,
  projects = [],
  editable = false,
  onFieldChange,
  onAddNote,
  onDeleteNote,
  onDelete,
}: TaskDetailProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const [newNote, setNewNote] = useState('')
  const [editingDue, setEditingDue] = useState(false)

  const isOverdue = task.due_at && new Date(task.due_at) < new Date()
  const priority = PRIORITY_OPTIONS.find((p) => p.value === task.priority) || PRIORITY_OPTIONS[0]

  const handleTitleSave = () => {
    if (titleDraft.trim() && titleDraft.trim() !== task.title) {
      onFieldChange?.('title', titleDraft.trim())
    }
    setEditingTitle(false)
  }

  const handleAddNote = () => {
    if (newNote.trim()) {
      onAddNote?.(newNote.trim())
      setNewNote('')
    }
  }

  return (
    <div className="space-y-6">
      {/* Title with delete button */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          {editable && editingTitle ? (
            <Input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSave()
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
              onClick={() => {
                if (editable) {
                  setTitleDraft(task.title)
                  setEditingTitle(true)
                }
              }}
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

        {/* Delete button */}
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

      {/* Fields */}
      <div className="space-y-4">
        {/* Due date */}
        <DetailField label="Due">
          {editable ? (
            editingDue ? (
              <div className="flex gap-2">
                <Input
                  type="datetime-local"
                  defaultValue={task.due_at ? toLocalDatetime(task.due_at) : ''}
                  onChange={(e) => {
                    if (e.target.value) {
                      onFieldChange?.('due_at', new Date(e.target.value).toISOString())
                    } else {
                      onFieldChange?.('due_at', null)
                    }
                    setEditingDue(false)
                  }}
                  onBlur={() => setEditingDue(false)}
                  className="w-auto"
                  autoFocus
                />
              </div>
            ) : (
              <span
                className={cn(
                  'hover:text-primary cursor-pointer',
                  isOverdue && 'text-destructive font-medium',
                )}
                onClick={() => setEditingDue(true)}
              >
                {task.due_at ? formatDateTime(task.due_at) : 'No due date (click to set)'}
              </span>
            )
          ) : (
            <span className={cn(isOverdue && 'text-destructive font-medium')}>
              {task.due_at ? (
                formatDateTime(task.due_at)
              ) : (
                <span className="text-muted-foreground">No due date</span>
              )}
            </span>
          )}
        </DetailField>

        {/* Priority */}
        <DetailField label="Priority">
          {editable ? (
            <div className="flex gap-1">
              {PRIORITY_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={task.priority === opt.value ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => onFieldChange?.('priority', opt.value)}
                  className={cn('text-xs', opt.color)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          ) : (
            <span className={priority.color}>{priority.label}</span>
          )}
        </DetailField>

        {/* Project */}
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

        {/* Labels */}
        <DetailField label="Labels">
          {editable ? (
            <EditableLabels
              labels={task.labels}
              onChange={(labels) => onFieldChange?.('labels', labels)}
            />
          ) : task.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {task.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </DetailField>

        {/* Recurrence */}
        {task.rrule && (
          <DetailField label="Recurrence">
            {formatRRule(task.rrule, task.anchor_time)}
            <span className="text-muted-foreground ml-2 text-sm">
              ({task.recurrence_mode === 'from_completion' ? 'from completion' : 'from due date'})
            </span>
          </DetailField>
        )}

        {/* Snoozed info */}
        {task.snoozed_from && (
          <DetailField label="Snoozed">
            <span className="text-blue-500">
              Originally due {formatDateTime(task.snoozed_from)}
            </span>
          </DetailField>
        )}

        {/* Created / Updated */}
        <DetailField label="Created">{formatDateTime(task.created_at)}</DetailField>

        {task.updated_at !== task.created_at && (
          <DetailField label="Updated">{formatDateTime(task.updated_at)}</DetailField>
        )}
      </div>

      {/* Notes */}
      <div>
        <h2 className="text-muted-foreground mb-3 text-sm font-semibold tracking-wider uppercase">
          Notes
          <span className="text-muted-foreground/60 ml-2">{notes.length}</span>
        </h2>

        {/* Add note form */}
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
                  <p className="text-muted-foreground text-xs">{formatDateTime(note.created_at)}</p>
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
    </div>
  )
}

function EditableLabels({
  labels,
  onChange,
}: {
  labels: string[]
  onChange: (labels: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const handleAdd = () => {
    const trimmed = draft.trim()
    if (trimmed && !labels.includes(trimmed)) {
      onChange([...labels, trimmed])
    }
    setDraft('')
    setAdding(false)
  }

  const handleRemove = (label: string) => {
    onChange(labels.filter((l) => l !== label))
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="secondary" className="gap-1">
          {label}
          <button onClick={() => handleRemove(label)} className="hover:text-destructive">
            &times;
          </button>
        </Badge>
      ))}
      {adding ? (
        <Input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleAdd}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          className="h-6 w-24 text-xs"
          placeholder="label"
          autoFocus
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
          className="h-6 border-dashed text-xs"
        >
          + Add
        </Button>
      )}
    </div>
  )
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="text-muted-foreground w-24 flex-shrink-0 pt-0.5 text-sm">{label}</span>
      <div className="flex-1 text-sm">{children}</div>
    </div>
  )
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function toLocalDatetime(iso: string): string {
  const d = new Date(iso)
  const offset = d.getTimezoneOffset()
  const local = new Date(d.getTime() - offset * 60 * 1000)
  return local.toISOString().slice(0, 16)
}
