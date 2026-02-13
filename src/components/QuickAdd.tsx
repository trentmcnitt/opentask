'use client'

import { useState, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface QuickAddProps {
  onAdd: (title: string) => void
  onOpenAddForm?: (title: string) => void
}

export function QuickAdd({ onAdd, onOpenAddForm }: QuickAddProps) {
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
    <div>
      <div
        className={cn(
          'bg-card flex items-center gap-2 rounded-lg border p-3',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          'transition-all',
        )}
      >
        <button
          type="button"
          onClick={() => {
            onOpenAddForm?.(title)
            setTitle('')
          }}
          className="hover:text-primary hover:bg-accent text-muted-foreground flex-shrink-0 rounded p-0.5 transition-colors"
          aria-label="Open full add form"
        >
          <Plus className="size-5" />
        </button>
        <Input
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
          className="h-auto flex-1 border-0 p-0 shadow-none focus-visible:ring-0"
          aria-label="Quick add task"
          disabled={submitting}
        />
      </div>
    </div>
  )
}
