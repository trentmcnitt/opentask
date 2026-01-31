'use client'

import { useState, useRef } from 'react'

interface QuickAddProps {
  onAdd: (title: string) => void
}

export function QuickAdd({ onAdd }: QuickAddProps) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async () => {
    const trimmed = title.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      onAdd(trimmed)
      setTitle('')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 focus-within:border-blue-500 dark:focus-within:border-blue-500 transition-colors">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-zinc-400 flex-shrink-0"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="Add a task..."
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          aria-label="Quick add task"
          disabled={submitting}
        />
      </div>
    </div>
  )
}
