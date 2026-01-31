'use client'

import { useState, useEffect, useRef } from 'react'

interface AddTaskFormProps {
  projects: { id: number; name: string }[]
  onClose: () => void
  onCreated: () => void
}

export function AddTaskForm({ projects, onClose, onCreated }: AddTaskFormProps) {
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [projectId, setProjectId] = useState<number | ''>('')
  const [priority, setPriority] = useState(0)
  const [labels, setLabels] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { title: title.trim() }
      if (dueAt) body.due_at = new Date(dueAt).toISOString()
      if (projectId) body.project_id = projectId
      if (priority > 0) body.priority = priority
      if (labels.trim()) {
        body.labels = labels.split(',').map((l) => l.trim()).filter(Boolean)
      }

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
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-task-title"
        className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl shadow-xl animate-slide-up"
      >
        <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 id="add-task-title" className="text-lg font-semibold">New Task</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Title */}
          <div>
            <label htmlFor="task-title" className="block text-sm font-medium mb-1">Title</label>
            <input
              ref={titleRef}
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
              required
            />
          </div>

          {/* Due date */}
          <div>
            <label htmlFor="task-due" className="block text-sm font-medium mb-1">Due date</label>
            <input
              id="task-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Project */}
            <div>
              <label htmlFor="task-project" className="block text-sm font-medium mb-1">Project</label>
              <select
                id="task-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value ? parseInt(e.target.value) : '')}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
              >
                <option value="">Inbox</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label htmlFor="task-priority" className="block text-sm font-medium mb-1">Priority</label>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value))}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
              >
                <option value={0}>None</option>
                <option value={1}>Low</option>
                <option value={2}>Medium</option>
                <option value={3}>High</option>
                <option value={4}>Urgent</option>
              </select>
            </div>
          </div>

          {/* Labels */}
          <div>
            <label htmlFor="task-labels" className="block text-sm font-medium mb-1">Labels (comma-separated)</label>
            <input
              id="task-labels"
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="e.g. home, errand"
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={!title.trim() || submitting}
            className="w-full py-2.5 rounded-lg bg-blue-500 text-white font-medium text-sm disabled:opacity-50 hover:bg-blue-600 transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Task'}
          </button>
        </form>

        <div className="h-6 sm:hidden" />
      </div>
    </div>
  )
}
