'use client'

import { useState } from 'react'
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
}

const PRIORITY_OPTIONS = [
  { value: 0, label: 'None', color: 'text-zinc-400' },
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
      {/* Title */}
      <div>
        {editable && editingTitle ? (
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave() }}
            className="text-2xl font-semibold w-full bg-transparent border-b-2 border-blue-500 outline-none"
            autoFocus
          />
        ) : (
          <h1
            className={`text-2xl font-semibold ${editable ? 'cursor-pointer hover:text-blue-500 transition-colors' : ''}`}
            onClick={() => { if (editable) { setTitleDraft(task.title); setEditingTitle(true) } }}
          >
            {task.title}
          </h1>
        )}
        {task.done && (
          <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">
            Completed
          </span>
        )}
      </div>

      {/* Fields */}
      <div className="space-y-4">
        {/* Due date */}
        <DetailField label="Due">
          {editable ? (
            editingDue ? (
              <div className="flex gap-2">
                <input
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
                  className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                  autoFocus
                />
              </div>
            ) : (
              <span
                className={`cursor-pointer hover:text-blue-500 ${isOverdue ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}
                onClick={() => setEditingDue(true)}
              >
                {task.due_at ? formatDateTime(task.due_at) : 'No due date (click to set)'}
              </span>
            )
          ) : (
            <span className={isOverdue ? 'text-red-600 dark:text-red-400 font-medium' : ''}>
              {task.due_at ? formatDateTime(task.due_at) : <span className="text-zinc-400">No due date</span>}
            </span>
          )}
        </DetailField>

        {/* Priority */}
        <DetailField label="Priority">
          {editable ? (
            <div className="flex gap-1">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onFieldChange?.('priority', opt.value)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    task.priority === opt.value
                      ? 'bg-zinc-200 dark:bg-zinc-700 font-medium'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  } ${opt.color}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : (
            <span className={priority.color}>{priority.label}</span>
          )}
        </DetailField>

        {/* Project */}
        <DetailField label="Project">
          {editable && projects.length > 0 ? (
            <select
              value={task.project_id}
              onChange={(e) => onFieldChange?.('project_id', parseInt(e.target.value))}
              className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
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
          ) : (
            task.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {task.labels.map((label) => (
                  <span key={label} className="px-2 py-0.5 text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {label}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-zinc-400">None</span>
            )
          )}
        </DetailField>

        {/* Recurrence */}
        {task.rrule && (
          <DetailField label="Recurrence">
            {formatRRule(task.rrule, task.anchor_time)}
            <span className="ml-2 text-zinc-400 text-sm">
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
        <DetailField label="Created">
          {formatDateTime(task.created_at)}
        </DetailField>

        {task.updated_at !== task.created_at && (
          <DetailField label="Updated">
            {formatDateTime(task.updated_at)}
          </DetailField>
        )}
      </div>

      {/* Notes */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">
          Notes
          <span className="ml-2 text-zinc-400 dark:text-zinc-500">{notes.length}</span>
        </h2>

        {/* Add note form */}
        {editable && onAddNote && (
          <div className="mb-4 flex gap-2">
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddNote() }}
              placeholder="Add a note..."
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
            />
            <button
              onClick={handleAddNote}
              disabled={!newNote.trim()}
              className="px-3 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium disabled:opacity-50 hover:bg-blue-600 transition-colors"
            >
              Add
            </button>
          </div>
        )}

        {notes.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">No notes yet.</p>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="group p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800"
              >
                <p className="text-sm whitespace-pre-wrap">{note.content}</p>
                <div className="flex items-center justify-between mt-2">
                  <p className="text-xs text-zinc-400">
                    {formatDateTime(note.created_at)}
                  </p>
                  {editable && onDeleteNote && (
                    <button
                      onClick={() => onDeleteNote(note.id)}
                      className="text-xs text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
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

function EditableLabels({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
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
    <div className="flex flex-wrap gap-1 items-center">
      {labels.map((label) => (
        <span key={label} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
          {label}
          <button onClick={() => handleRemove(label)} className="hover:text-red-500">&times;</button>
        </span>
      ))}
      {adding ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleAdd}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
          className="px-2 py-0.5 text-xs rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
          placeholder="label"
          autoFocus
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="px-2 py-0.5 text-xs rounded-full border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-400 hover:text-zinc-600 hover:border-zinc-400"
        >
          + Add
        </button>
      )}
    </div>
  )
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-24 flex-shrink-0 text-sm text-zinc-500 dark:text-zinc-400 pt-0.5">
        {label}
      </span>
      <div className="text-sm flex-1">{children}</div>
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
