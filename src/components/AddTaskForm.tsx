'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RecurrencePicker } from '@/components/RecurrencePicker'

interface AddTaskFormProps {
  projects: { id: number; name: string }[]
  onClose: () => void
  onCreated: () => void
}

export function AddTaskForm({ projects, onClose, onCreated }: AddTaskFormProps) {
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [projectId, setProjectId] = useState<string>('inbox')
  const [priority, setPriority] = useState<string>('0')
  const [labels, setLabels] = useState('')
  const [rrule, setRrule] = useState<string | null>(null)
  const [showRecurrence, setShowRecurrence] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const handleRruleChange = useCallback((value: string | null) => {
    setRrule(value)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { title: title.trim() }
      if (dueAt) body.due_at = new Date(dueAt).toISOString()
      if (projectId && projectId !== 'inbox') body.project_id = parseInt(projectId)
      if (parseInt(priority) > 0) body.priority = parseInt(priority)
      if (labels.trim()) {
        body.labels = labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean)
      }
      if (rrule) body.rrule = rrule

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) throw new Error('Failed to create task')
      onCreated()
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" showCloseButton={false}>
        <DialogHeader className="flex flex-row items-center justify-between">
          <div>
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription className="sr-only">
              Create a new task with title, due date, project, and priority
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label htmlFor="task-title" className="mb-1 block text-sm font-medium">
              Title
            </label>
            <Input
              ref={titleRef}
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              required
            />
          </div>

          {/* Due date */}
          <div>
            <label htmlFor="task-due" className="mb-1 block text-sm font-medium">
              Due date
            </label>
            <Input
              id="task-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Project */}
            <div>
              <label htmlFor="task-project" className="mb-1 block text-sm font-medium">
                Project
              </label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Inbox" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inbox">Inbox</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Priority */}
            <div>
              <label htmlFor="task-priority" className="mb-1 block text-sm font-medium">
                Priority
              </label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">None</SelectItem>
                  <SelectItem value="1">Low</SelectItem>
                  <SelectItem value="2">Medium</SelectItem>
                  <SelectItem value="3">High</SelectItem>
                  <SelectItem value="4">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Recurrence */}
          <div>
            <button
              type="button"
              onClick={() => setShowRecurrence(!showRecurrence)}
              className="hover:text-primary mb-1 flex items-center gap-2 text-sm font-medium transition-colors"
            >
              Repeat
              {showRecurrence ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              {rrule && <span className="text-muted-foreground font-normal">(configured)</span>}
            </button>
            {showRecurrence && (
              <div className="mt-1 rounded-lg border p-3">
                <RecurrencePicker value={rrule} onChange={handleRruleChange} />
              </div>
            )}
          </div>

          {/* Labels */}
          <div>
            <label htmlFor="task-labels" className="mb-1 block text-sm font-medium">
              Labels (comma-separated)
            </label>
            <Input
              id="task-labels"
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="e.g. home, errand"
            />
          </div>

          <Button type="submit" disabled={!title.trim() || submitting} className="w-full">
            {submitting ? 'Creating...' : 'Create Task'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
